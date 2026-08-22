/**
 * SSH grading backend (ADR-0536 P0).
 *
 * Grades against a BYO, already-bootstrapped remote box (docker + uvx +
 * swebench). Mirrors stages 3–5 of `docs/swebench-ec2-runbook.md`:
 *
 *   1. scp predictions  → ~/preds.jsonl
 *   2. scp dataset      → ~/instances.jsonl
 *   3. ssh `uvx ... run_evaluation` (nohup, background) — survives a dropped link
 *   4. poll until the report `<model>.<runId>.json` exists on the box
 *   5. scp the report back to `outDir`, parse → GradeOutcome
 *
 * Every external call goes through the injected {@link SpawnFn}; the EC2
 * backend reuses this module against a freshly-provisioned host.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { resolveDatasetFamilyProfile } from "../profiles/registry"
import { SPHINX_RA_SHIM } from "../python-swebench"
import { datasetFamilyOrDefault } from "../run-config"
import {
  DEFAULT_MAX_WORKERS,
  defaultSpawn,
  type GradeBackend,
  type GradeOptions,
  type GradeOutcome,
  parseSwebenchReport,
  type SpawnFn,
} from "./backend"

export interface SshBackendConfig {
  /** `user@ip` ssh target. */
  readonly host: string
  /** Private key path (`~` expanded). */
  readonly keyPath: string
  /** Default `--max_workers` for this backend (per-call opt can override). */
  readonly maxWorkers?: number
  /** Process boundary; defaults to {@link defaultSpawn}. */
  readonly spawn?: SpawnFn
  /**
   * model_name_or_path baked into the predictions rows — determines the
   * report filename `<model>.<runId>.json`. Default "quanta" (matches the
   * local predictions writer). Tests/callers override when predictions use a
   * different name.
   */
  readonly modelName?: string
  /** Poll interval (ms) while waiting for the report. Default 15000. */
  readonly pollIntervalMs?: number
  /** Max polls before giving up. Default 240 (≈1h at 15s). */
  readonly maxPolls?: number
  /** Injectable sleep (tests pass a no-op to avoid real waits). */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Expand a leading `~` to the home dir. Pure string op (no fs). */
const expandHome = (p: string): string => {
  if (p === "~") return process.env.HOME ?? p
  if (p.startsWith("~/")) return `${process.env.HOME ?? "~"}/${p.slice(2)}`
  return p
}

/**
 * Common ssh/scp flags: explicit key + auto-accept host key (fresh boxes) +
 * fail-fast networking. The timeout/keepalive triad is NOT cosmetic: without it
 * a flaky box (a TCP black-hole on :22) makes any scp/ssh hang INDEFINITELY —
 * and the report-back + error-log fetch run AFTER the grade already succeeded, so
 * a hang there strands a completed grade forever. `BatchMode=yes` also prevents a
 * key-auth failure from blocking on an interactive password prompt. Mirrors the
 * sibling `BENCH_SSH_SAFE_OPTS`/`makeSsh` SSOT (which the full-remote path already
 * carries) — closing the asymmetry flagged by the jun-28 hardening audit.
 */
const sshFlags = (keyPath: string): readonly string[] => [
  "-i",
  expandHome(keyPath),
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
]

/**
 * Remote run_evaluation command (mirrors the validated runbook). Started under
 * nohup in the background so the grading survives an ssh disconnect; the report
 * file is polled separately. `--namespace swebench` pulls prebuilt amd64 images;
 * `--cache_level instance` keeps them warm across instances.
 *
 * jun-28: runs via the SHARED `SPHINX_RA_SHIM` (same as the local buildArgv path)
 * instead of bare `-m swebench.harness.run_evaluation`, so sphinx's tox test_cmd
 * gets `-rA` and isn't false-unresolved here either. The shim is base64-shipped to
 * `~/ra_shim.py` — NOT a heredoc, because this script is itself piped to `bash -s`
 * over stdin and a heredoc would steal that stdin. `python ra_shim.py <args>` makes
 * the shim's `runpy.run_module(..., run_name="__main__")` see `<args>` as argv.
 */
export const buildRemoteGradeScript = (
  maxWorkers: number,
  /** Harness install spec (`--from`): stock `swebench` for verified/pro, the
   *  SWE-bench-Live fork for live. Resolved by the caller via the SSOT
   *  the family profile's `harnessSpec` port so this grade-only path agrees with the
   *  full-remote box path. Defaults to `swebench` (byte-identical legacy). */
  fromSpec = "swebench",
  /** Prebuilt-image org (`--namespace`): `swebench` for verified/pro,
   *  `starryzhang` for live (resolved via the same `harnessSpec` port). */
  namespace = "swebench",
): string => {
  const shimB64 = Buffer.from(SPHINX_RA_SHIM, "utf8").toString("base64")
  return [
    "set -eu",
    "UVX=$(command -v uvx || echo ~/.local/bin/uvx)",
    `printf %s ${shimB64} | base64 -d > ~/ra_shim.py`,
    `nohup "$UVX" --from ${fromSpec} --python 3.11 python ~/ra_shim.py \\`,
    "  --predictions_path ~/preds.jsonl \\",
    "  --run_id RUNID \\",
    `  --max_workers ${maxWorkers} \\`,
    "  --cache_level instance \\",
    `  --namespace ${namespace} \\`,
    "  --dataset_name ~/instances.jsonl \\",
    "  > ~/grade.log 2>&1 &",
    "echo STARTED",
    "",
  ].join("\n")
}

/**
 * The harness mangles `model_name_or_path` with `.replace("/", "__")` before it
 * names BOTH the report file and the per-instance log dir
 * (run_evaluation.py:93). We must replicate that mangling or every path with a
 * slash-bearing model name (e.g. an HF-style `org/model`) silently mismatches —
 * the report poll would 404 and the error-log fetch would pull nothing. Today's
 * names ("quanta", "gpt-5.4") have no slash so this is a no-op, but the harness
 * contract — not the current naming luck — is what we encode. Idempotent.
 */
const sanitizeModelName = (model: string): string => model.replace(/\//g, "__")

/** Cap on per-grade error-log fetches — beyond this an env/build break has
 *  errored most of the slice (a systemic failure, not per-instance debugging),
 *  and N serial scp round-trips aren't worth it. The error COUNT is still
 *  surfaced by the report tally, so truncation is never silent-as-complete. */
const MAX_ERROR_LOG_FETCH = 50

/**
 * Remote per-instance swebench log dir for `id` under this run. Mirrors the
 * harness convention `RUN_EVALUATION_LOG_DIR / run_id / model / instance_id`
 * (constants.py: `RUN_EVALUATION_LOG_DIR = Path("logs/run_evaluation")`), rooted
 * at `~` because the grade runs under nohup from the home dir. The dir holds
 * `run_instance.log` + `test_output.txt` — the only ground-truth for WHY an
 * instance errored. Pure string op (no fs / no network) so it's unit-testable.
 * `model` is sanitized to match the harness's `/`→`__` mangling.
 */
export const remoteInstanceLogDir = (runId: string, model: string, id: string): string =>
  `~/logs/run_evaluation/${runId}/${sanitizeModelName(model)}/${id}`

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const createSshBackend = (cfg: SshBackendConfig): GradeBackend => {
  const spawn = cfg.spawn ?? defaultSpawn
  const sleep = cfg.sleep ?? delay
  // Sanitized at the source so BOTH the report filename and the per-instance log
  // path match the harness's `/`→`__` mangling (run_evaluation.py:93).
  const model = sanitizeModelName(cfg.modelName ?? "quanta")
  const pollIntervalMs = cfg.pollIntervalMs ?? 15_000
  const maxPolls = cfg.maxPolls ?? 240

  const grade = async (predictionsPath: string, opts: GradeOptions): Promise<GradeOutcome> => {
    const maxWorkers = opts.maxWorkers ?? cfg.maxWorkers ?? DEFAULT_MAX_WORKERS
    const reportName = `${model}.${opts.runId}.json`
    const flags = sshFlags(cfg.keyPath)

    // 1) scp predictions → ~/preds.jsonl
    const up1 = await spawn("scp", [...flags, predictionsPath, `${cfg.host}:~/preds.jsonl`])
    if (up1.code !== 0) {
      throw new Error(`[ssh-backend] scp predictions failed (code ${up1.code}): ${up1.stderr}`)
    }

    // 2) scp dataset → ~/instances.jsonl
    const up2 = await spawn("scp", [...flags, opts.datasetPath, `${cfg.host}:~/instances.jsonl`])
    if (up2.code !== 0) {
      throw new Error(`[ssh-backend] scp dataset failed (code ${up2.code}): ${up2.stderr}`)
    }

    // 3) ssh run_evaluation (nohup background). The run_id is substituted into
    //    the streamed script (the script body is piped to `bash -s` via stdin).
    // Function replacer (not a string): a string replacement would interpret
    // `$` sequences in run_id (`$&`, `$1`, …) as patterns and corrupt the id.
    // Family-aware harness fork + image namespace (RFC jun-29): a `live` grade
    // must install the SWE-bench-Live fork + pull `starryzhang` images, else the
    // stock `swebench` harness KeyErrors on Live repos. Reuses the SAME SSOT
    // resolvers as the full-remote box path; operator env overrides still win.
    // aug-22 HIGH-4: the harness build comes from the family PROFILE's
    // `harnessSpec` port (the same port the full-remote box path uses), so this
    // grade-only path cannot drift from it and knows no family names itself.
    // The ABSENT-selector default comes from its ONE owner (`datasetFamilyOrDefault`,
    // re-audit R4), not a private literal here — this layer knows no family names.
    const { pipSpec: fromSpec, namespace } = resolveDatasetFamilyProfile(
      datasetFamilyOrDefault(opts.family),
    ).harnessSpec({
      datasetName: opts.datasetPath,
      pipSpecOverride: process.env.QUANTA_SWEBENCH_PIP_SPEC,
      namespaceOverride: process.env.QUANTA_SWEBENCH_NAMESPACE,
    })
    const script = buildRemoteGradeScript(maxWorkers, fromSpec, namespace).replace(
      "RUNID",
      () => opts.runId,
    )
    const run = await spawn("ssh", [...flags, cfg.host, "bash", "-s"], { input: script })
    if (run.code !== 0) {
      throw new Error(
        `[ssh-backend] remote run_evaluation start failed (code ${run.code}): ${run.stderr}`,
      )
    }

    // 4) poll until the report file exists on the box.
    let ready = false
    for (let i = 0; i < maxPolls; i++) {
      const check = await spawn("ssh", [
        ...flags,
        cfg.host,
        `test -f ~/${reportName} && echo READY || echo WAIT`,
      ])
      if (check.stdout.includes("READY")) {
        ready = true
        break
      }
      await sleep(pollIntervalMs)
    }
    if (!ready) {
      throw new Error(
        `[ssh-backend] report ~/${reportName} did not appear after ${maxPolls} polls (~${(maxPolls * pollIntervalMs) / 60000}m)`,
      )
    }

    // 5) scp report back → outDir, parse.
    const outDir = opts.outDir ?? mkdtempSync(join(tmpdir(), "quanta-bench-grade-"))
    const reportPath = join(outDir, reportName)
    const down = await spawn("scp", [...flags, `${cfg.host}:~/${reportName}`, reportPath])
    if (down.code !== 0) {
      throw new Error(`[ssh-backend] scp report back failed (code ${down.code}): ${down.stderr}`)
    }

    let parsed: ReturnType<typeof parseSwebenchReport>
    try {
      parsed = parseSwebenchReport(JSON.parse(await readFile(reportPath, "utf8")))
    } catch (err) {
      throw new Error(
        `[ssh-backend] retrieved report ${reportPath} was not valid json: ${errMessage(err)}`,
      )
    }

    // 6) observability: for ERROR instances, pull each one's remote swebench log
    //    dir back to `<outDir>/error-logs/<id>/`. This is the only ground-truth
    //    for WHY an instance errored (env/build/collection), and a manual ssh to
    //    the box is often blocked or the box is gone. Best-effort: a missing log
    //    or a failed scp must NOT fail the grade — the report already parsed.
    let errorLogDir: string | undefined
    if (parsed.errored.length > 0) {
      errorLogDir = join(outDir, "error-logs")
      try {
        mkdirSync(errorLogDir, { recursive: true })
      } catch {
        // a mkdir failure (perms) shouldn't sink the grade; skip the fetch.
        errorLogDir = undefined
      }
      if (errorLogDir !== undefined) {
        // Cap the serial fetches: a slice that errored >MAX is a systemic break,
        // not per-instance debugging fodder (the count is still in the tally).
        for (const id of parsed.errored.slice(0, MAX_ERROR_LOG_FETCH)) {
          const dest = join(errorLogDir, id)
          try {
            // `scp -r` nests the source UNDER an existing dest (→ <id>/<id>) on a
            // re-grade into the same outDir; clear the dest first so the logs land
            // at <id>/ directly. force:true ⇒ a missing dest is a no-op.
            rmSync(dest, { recursive: true, force: true })
            await spawn("scp", [
              ...flags,
              "-r",
              `${cfg.host}:${remoteInstanceLogDir(opts.runId, model, id)}`,
              dest,
            ])
            // non-zero code is tolerated (log dir may not exist for a crash
            // that never reached the per-instance stage) — best-effort.
          } catch {
            // even a thrown spawn (reaped child) or rmSync must not break the outcome.
          }
        }
      }
    }

    return { reportPath, ...parsed, ...(errorLogDir !== undefined ? { errorLogDir } : {}) }
  }

  return { name: `ssh:${cfg.host}`, grade }
}
