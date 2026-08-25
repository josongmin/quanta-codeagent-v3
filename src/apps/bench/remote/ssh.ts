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

/** Everything the stage helpers need to reach the box. Bundled because the
 *  four of them travel together through every stage; passing them one at a time
 *  is how a stage ends up reading the enclosing closure instead of its args. */
interface RemoteConn {
  readonly spawn: SpawnFn
  readonly flags: readonly string[]
  readonly host: string
}

/** STAGE 1+2 — one upload. A unit because the three `scp … ; if (code) throw`
 *  blocks were the SAME four lines with a different label; the label is now the
 *  only thing a caller varies, so a new transfer cannot forget the guard. */
const scpOrThrow = async (
  conn: RemoteConn,
  from: string,
  to: string,
  what: string,
): Promise<void> => {
  const out = await conn.spawn("scp", [...conn.flags, from, to])
  if (out.code !== 0) {
    throw new Error(`[ssh-backend] ${what} failed (code ${out.code}): ${out.stderr}`)
  }
}

/** STAGE 3 — start `run_evaluation` on the box under nohup.
 *  A unit because the family/namespace resolution and the script it produces
 *  are one decision: the script is only correct for the harness spec that
 *  resolved it. */
const startRemoteEvaluation = async (
  conn: RemoteConn,
  opts: GradeOptions,
  maxWorkers: number,
): Promise<void> => {
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
  // Function replacer (not a string): a string replacement would interpret
  // `$` sequences in run_id (`$&`, `$1`, …) as patterns and corrupt the id.
  const script = buildRemoteGradeScript(maxWorkers, fromSpec, namespace).replace(
    "RUNID",
    () => opts.runId,
  )
  const run = await conn.spawn("ssh", [...conn.flags, conn.host, "bash", "-s"], { input: script })
  if (run.code !== 0) {
    throw new Error(
      `[ssh-backend] remote run_evaluation start failed (code ${run.code}): ${run.stderr}`,
    )
  }
}

/** STAGE 4 — poll until the report file exists on the box, or give up.
 *  A unit because the loop and its exhaustion message are one contract: the
 *  message quotes the very budget the loop spent. */
const waitForRemoteReport = async (
  conn: RemoteConn,
  reportName: string,
  budget: { readonly maxPolls: number; readonly pollIntervalMs: number },
  sleep: (ms: number) => Promise<void>,
): Promise<void> => {
  for (let i = 0; i < budget.maxPolls; i++) {
    const check = await conn.spawn("ssh", [
      ...conn.flags,
      conn.host,
      `test -f ~/${reportName} && echo READY || echo WAIT`,
    ])
    if (check.stdout.includes("READY")) return
    await sleep(budget.pollIntervalMs)
  }
  throw new Error(
    `[ssh-backend] report ~/${reportName} did not appear after ${budget.maxPolls} polls (~${(budget.maxPolls * budget.pollIntervalMs) / 60000}m)`,
  )
}

/** STAGE 5 — read + parse the retrieved report. A unit so the "not valid json"
 *  message has exactly one origin and the `let parsed` definite-assignment
 *  dance disappears with it. */
const readRetrievedReport = async (
  reportPath: string,
): Promise<ReturnType<typeof parseSwebenchReport>> => {
  try {
    return parseSwebenchReport(JSON.parse(await readFile(reportPath, "utf8")))
  } catch (err) {
    throw new Error(
      `[ssh-backend] retrieved report ${reportPath} was not valid json: ${errMessage(err)}`,
    )
  }
}

/** STAGE 6 — observability: for ERROR instances, pull each one's remote swebench
 *  log dir back to `<outDir>/error-logs/<id>/`. This is the only ground-truth
 *  for WHY an instance errored (env/build/collection), and a manual ssh to the
 *  box is often blocked or the box is gone.
 *
 *  A unit because it is the one stage that is entirely BEST-EFFORT: every step
 *  inside swallows its failure, and the whole stage returns `undefined` rather
 *  than failing a grade whose report already parsed. Returns the directory it
 *  actually populated, or `undefined` when it did nothing. */
const fetchErrorLogs = async (
  conn: RemoteConn,
  args: {
    readonly outDir: string
    readonly runId: string
    readonly model: string
    readonly erroredIds: readonly string[]
  },
): Promise<string | undefined> => {
  if (args.erroredIds.length === 0) return undefined
  const errorLogDir = join(args.outDir, "error-logs")
  try {
    mkdirSync(errorLogDir, { recursive: true })
  } catch {
    // a mkdir failure (perms) shouldn't sink the grade; skip the fetch.
    return undefined
  }
  // Cap the serial fetches: a slice that errored >MAX is a systemic break,
  // not per-instance debugging fodder (the count is still in the tally).
  for (const id of args.erroredIds.slice(0, MAX_ERROR_LOG_FETCH)) {
    const dest = join(errorLogDir, id)
    try {
      // `scp -r` nests the source UNDER an existing dest (→ <id>/<id>) on a
      // re-grade into the same outDir; clear the dest first so the logs land
      // at <id>/ directly. force:true ⇒ a missing dest is a no-op.
      rmSync(dest, { recursive: true, force: true })
      await conn.spawn("scp", [
        ...conn.flags,
        "-r",
        `${conn.host}:${remoteInstanceLogDir(args.runId, args.model, id)}`,
        dest,
      ])
      // non-zero code is tolerated (log dir may not exist for a crash
      // that never reached the per-instance stage) — best-effort.
    } catch {
      // even a thrown spawn (reaped child) or rmSync must not break the outcome.
    }
  }
  return errorLogDir
}

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
    const conn: RemoteConn = { spawn, flags: sshFlags(cfg.keyPath), host: cfg.host }

    await scpOrThrow(conn, predictionsPath, `${cfg.host}:~/preds.jsonl`, "scp predictions")
    await scpOrThrow(conn, opts.datasetPath, `${cfg.host}:~/instances.jsonl`, "scp dataset")
    await startRemoteEvaluation(conn, opts, maxWorkers)
    await waitForRemoteReport(conn, reportName, { maxPolls, pollIntervalMs }, sleep)

    const outDir = opts.outDir ?? mkdtempSync(join(tmpdir(), "quanta-bench-grade-"))
    const reportPath = join(outDir, reportName)
    await scpOrThrow(conn, `${cfg.host}:~/${reportName}`, reportPath, "scp report back")
    const parsed = await readRetrievedReport(reportPath)

    const errorLogDir = await fetchErrorLogs(conn, {
      outDir,
      runId: opts.runId,
      model,
      erroredIds: parsed.errored,
    })
    return { reportPath, ...parsed, ...(errorLogDir !== undefined ? { errorLogDir } : {}) }
  }

  return { name: `ssh:${cfg.host}`, grade }
}
