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
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
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

/** Common ssh/scp flags: explicit key + auto-accept host key (fresh boxes). */
const sshFlags = (keyPath: string): readonly string[] => [
  "-i",
  expandHome(keyPath),
  "-o",
  "StrictHostKeyChecking=accept-new",
]

/**
 * Remote run_evaluation command (mirrors the validated runbook). Started under
 * nohup in the background so the grading survives an ssh disconnect; the report
 * file is polled separately. `--namespace swebench` pulls prebuilt amd64 images;
 * `--cache_level instance` keeps them warm across instances.
 */
const buildRemoteGradeScript = (maxWorkers: number): string =>
  [
    "set -eu",
    "UVX=$(command -v uvx || echo ~/.local/bin/uvx)",
    'nohup "$UVX" --from swebench --python 3.11 python -m swebench.harness.run_evaluation \\',
    "  --predictions_path ~/preds.jsonl \\",
    "  --run_id RUNID \\",
    `  --max_workers ${maxWorkers} \\`,
    "  --cache_level instance \\",
    "  --namespace swebench \\",
    "  --dataset_name ~/instances.jsonl \\",
    "  > ~/grade.log 2>&1 &",
    "echo STARTED",
    "",
  ].join("\n")

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const createSshBackend = (cfg: SshBackendConfig): GradeBackend => {
  const spawn = cfg.spawn ?? defaultSpawn
  const sleep = cfg.sleep ?? delay
  const model = cfg.modelName ?? "quanta"
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
    const script = buildRemoteGradeScript(maxWorkers).replace("RUNID", () => opts.runId)
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

    return { reportPath, ...parsed }
  }

  return { name: `ssh:${cfg.host}`, grade }
}
