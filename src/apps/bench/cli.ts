#!/usr/bin/env bun
/**
 * `quanta-bench` — unified bench CLI (ADR-0536 P0).
 *
 * Subcommand dispatcher layered over the existing flat-flag runner (`runMain`
 * in `./index`) + the remote grade backends (`./remote`) + the analysis layer
 * (`./analyze`). Legacy invocation with NO subcommand (or a leading flag like
 * `--swebench`) routes to `run` so the historical
 * `bun run src/apps/bench/index.ts --swebench …` keeps working verbatim.
 *
 *   quanta-bench run         …flat flags…                 # local patch-gen + (optional) local grade
 *   quanta-bench grade       --predictions p.jsonl --backend <ec2|ssh:user@host> [--dataset ds] [--max-workers N] [--run-id id] [--key path] [--keep]
 *   quanta-bench diff        <reportA.json> <reportB.json>
 *   quanta-bench explain     --dataset <instances.jsonl> --instance <id> [--patch <agent.patch>]
 *   quanta-bench leaderboard <report.json> [more.json …] [--preset name] [--title T]
 *   quanta-bench presets
 *
 * `remote` grading = `grade --backend ec2` (the secure default: patch-gen stays
 * local, only grading is remote). Full remote patch-gen is ADR-0536 §6 (P3).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage, gateOn, logger, runtimeConfig, setTerminalIo } from "@/shared"
import { costSummaryFromReport, renderCost } from "./analyze/cost"
import { diffRuns, renderDiff } from "./analyze/diff"
import { explainFailure } from "./analyze/explain"
import { renderLeaderboardMarkdown, rowsFromRun } from "./analyze/leaderboard"
import { loadVerdictsFromFile } from "./analyze/verdicts"
import {
  AuthLeaseManager,
  type AuthSource,
  describeAuthSource,
  resolveAuthLaunchFile,
  resolveAuthSource,
  runBenchLogin,
  selectAuthSourceLabel,
} from "./auth-pool"
import {
  CURRENT_BENCH_BASE_PRESET,
  renderBenchPresetListLines,
  resolveBenchExecutionPreset,
} from "./preset"
import type { GradeBackend } from "./remote/backend"
import { boxRunLogPath, D, inspectBox, provisionBox } from "./remote/box-session"
import { createEc2Backend } from "./remote/ec2"
import { createFanoutBackend } from "./remote/fanout"
import { refreshRemoteAuthJson } from "./remote/fresh-auth"
import { buildForwardedBenchEnv, createFullRemoteBackend, runWithRelaunch } from "./remote/full"
import { type PoolChunk, runPool } from "./remote/pool"
import { createLeasePoolAuthProvider, type PoolAuthProvider } from "./remote/pool-auth"
import { createSshBackend } from "./remote/ssh"
import {
  clampPatchGenConcurrency,
  type PatchGenBudgetState,
  readPatchGenBudgetState,
  resolveGlobalPatchGenBudget,
} from "./remote/token-budget"
import {
  defaultMicrochunkDir,
  type Microchunk,
  planMicrochunks,
  writeMicrochunks,
} from "./slicing/microchunk"

// Route `logger` to the real terminal (same wiring index.ts does — without it
// logger.info writes nowhere).
setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
})

const KNOWN_SUBCOMMANDS = new Set([
  "run",
  "grade",
  "pool",
  "box",
  "auth",
  "remote",
  "diff",
  "explain",
  "leaderboard",
  "cost",
  "presets",
  "help",
  "--help",
  "-h",
])

/** Every `instance_id` in a SWE-bench dataset jsonl — the expected set that
 *  instance-aware relaunch reconciles against to detect partial box loss.
 *  Best-effort: unparseable/blank lines are skipped, a missing file ⇒ []. */
const readDatasetInstanceIds = (path: string): string[] => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const ids: string[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (t === "") continue
    try {
      const id = (JSON.parse(t) as { instance_id?: unknown }).instance_id
      if (typeof id === "string" && id !== "") ids.push(id)
    } catch {
      /* skip malformed line */
    }
  }
  return ids
}

/** Read a value flag in BOTH `--flag value` and `--flag=value` forms. The
 *  `=`-form previously fell through `indexOf` and was silently ignored. */
const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  if (i >= 0) return process.argv[i + 1]
  const pref = `${flag}=`
  const eq = process.argv.find((a) => a.startsWith(pref))
  return eq !== undefined ? eq.slice(pref.length) : undefined
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag)
const allowExtraBoxes = (): boolean =>
  hasFlag("--allow-extra-boxes") || gateOn(process.env, "QUANTA_ALLOW_EXTRA_BOXES")
const waitForIdleBox = (): boolean =>
  hasFlag("--wait-for-idle") || gateOn(process.env, "QUANTA_BENCH_WAIT_FOR_IDLE")

const resolveCliAuthSource = (): AuthSource => {
  const authPoolArg = argValue("--auth-pool")
  const authFileArg = argValue("--auth-file")
  const authLabelArg = argValue("--auth-label")
  const resolved = resolveAuthSource({
    env: process.env,
    ...(authPoolArg !== undefined ? { authPoolArg } : {}),
    ...(authFileArg !== undefined ? { authFileArg } : {}),
  })
  return authLabelArg !== undefined ? selectAuthSourceLabel(resolved, authLabelArg) : resolved
}

const positiveMinutesFlagMs = (flag: string): number | undefined => {
  const raw = argValue(flag)
  if (raw === undefined || raw.trim() === "") return undefined
  const mins = Number(raw)
  return Number.isFinite(mins) && mins > 0 ? mins * 60_000 : undefined
}

/** Print a render* block (diff / explain / leaderboard markdown) to raw stdout
 *  — NOT via `logger.info`, which prefixes `[info]`, mangles embedded `\n` to
 *  `?`, and de-dups repeated lines (which silently swallowed identical
 *  gold/agent file lines in `explain`). Raw output is also copy-pasteable. */
const printBlock = (s: string): void => {
  process.stdout.write(`${s}\n`)
}

/** Value-taking flags — their following token is a value, NOT a positional. */
const VALUE_FLAGS = new Set([
  "--predictions",
  "--backend",
  "--dataset",
  "--max-workers",
  "--run-id",
  "--key",
  "--out",
  "--region",
  "--preset",
  "--title",
  "--patch",
  "--instance",
  "--datasets",
  "--workers",
  "--ami",
  "--max-box-wall-min",
  "--shards",
  "--observe-dir",
  "--mode",
  "--model",
  "--lines",
  "--auth-pool",
  "--auth-file",
  "--auth-label",
  "--chunk-size",
  "--microchunk-dir",
  "--max-parallel",
])

/** Positional args after the subcommand (argv[2]), skipping flags AND the
 *  value token that follows a value-flag (so `--preset x` doesn't leak `x`). */
const positionals = (): string[] => {
  const rest = process.argv.slice(3)
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (tok === undefined) continue
    if (tok.startsWith("-")) {
      if (VALUE_FLAGS.has(tok)) i++ // skip its value
      continue
    }
    out.push(tok)
  }
  return out
}

/** model_name_or_path from the first prediction row — names the harness report
 *  file `<model>.<runId>.json`, so the backend must poll for the right name. */
const modelNameFromPredictions = (path: string): string | undefined => {
  try {
    const first = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.trim() !== "")
    if (first === undefined) return undefined
    const row = JSON.parse(first) as { model_name_or_path?: unknown }
    return typeof row.model_name_or_path === "string" ? row.model_name_or_path : undefined
  } catch {
    return undefined
  }
}

/** Coerce a prior report's `resolved_ids` to a clean `string[]` for `--skip-resolved`.
 *  Accepts a real string array OR a JSON-encoded string array (some swebench exports
 *  double-encode the id arrays); filters out non-strings / empties. Mirrors
 *  analyze/verdicts.ts strArray so a malformed report can't pollute the merged
 *  resolved tally or seed the skip set with non-string junk. */
export const resolvedIdsFromReport = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0)
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      }
    } catch {
      // not JSON — fall through
    }
  }
  return []
}

/** Parse `--max-workers` for the remote swebench grade harness. ABSENT ⇒ ok with
 *  no value (backend default applies). A POSITIVE integer ⇒ ok with that value.
 *  Zero / negative / non-integer garbage ⇒ `invalid` — `Number.isInteger(Number("0"))`
 *  and `Number.isInteger(Number("-5"))` are both true, so the prior inline parser
 *  shipped `--max_workers 0` / `-5` verbatim into the remote harness command
 *  (a broken grade run). Mirrors the strict `argPositiveInt` guard index.ts uses
 *  for this same class. Pure (string in) so it is unit-testable without argv. */
export const parseMaxWorkers = (
  raw: string | undefined,
): { ok: true; value?: number } | { ok: false; raw: string } => {
  if (raw === undefined || raw.trim() === "") return { ok: true }
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 1) return { ok: true, value: n }
  return { ok: false, raw }
}

/** Build ONE backend instance for `spec` (ec2 | ssh:host). A fresh call mints a
 *  fresh box (fanout uses this per shard). */
const buildBaseBackend = (spec: string, modelName: string | undefined): GradeBackend => {
  const mw = parseMaxWorkers(argValue("--max-workers"))
  if (!mw.ok) {
    logger.info(
      `refused: --max-workers must be a positive integer (got "${mw.raw}") — ` +
        "it is passed verbatim to the remote swebench grade harness.",
    )
    process.exit(2)
  }
  const maxWorkers = mw.value
  const common = {
    ...(modelName !== undefined ? { modelName } : {}),
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
  }
  if (spec === "ec2") {
    const region = argValue("--region")
    return createEc2Backend({
      ...common,
      keep: hasFlag("--keep"),
      // Same escape hatch as full-remote: on-demand when spot is being reclaimed.
      onDemand: gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND"),
      ...(region !== undefined ? { region } : {}),
    })
  }
  if (spec.startsWith("ssh:")) {
    const host = spec.slice("ssh:".length)
    const keyPath = argValue("--key") ?? `${process.env.HOME}/Downloads/pickinstead_korea.pem`
    return createSshBackend({ host, keyPath, ...common })
  }
  throw new Error(`unknown --backend "${spec}" (expected: ec2 | ssh:user@host)`)
}

/** Build the grading backend, wrapping in a K-way fan-out when `--shards > 1`
 *  (each shard mints its own fresh box via `buildBaseBackend`). */
const buildBackend = (spec: string, modelName: string | undefined): GradeBackend => {
  const sRaw = argValue("--shards")
  const shards = sRaw !== undefined && Number.isInteger(Number(sRaw)) ? Number(sRaw) : 1
  if (shards > 1) {
    return createFanoutBackend({ shards, makeBackend: () => buildBaseBackend(spec, modelName) })
  }
  return buildBaseBackend(spec, modelName)
}

/** Log the merged outcome of an instance-aware full-remote run — resolved count,
 *  any box-loss (`missing`, surfaced NOT silently dropped), and attempt count. */
const logFullRemoteOutcome = (out: {
  resolved: string[]
  unresolved: string[]
  missing: string[]
  attempts: number
}): void => {
  const lostNote = out.missing.length > 0 ? ` | ⚠️ LOST ${out.missing.length} (box-loss)` : ""
  const attemptNote = out.attempts > 1 ? ` [${out.attempts} attempts]` : ""
  logger.info(
    `full-remote done — resolved ${out.resolved.length} | unresolved ${out.unresolved.length}${lostNote}${attemptNote}`,
  )
  for (const id of out.resolved) logger.info(`  ✅ ${id}`)
  for (const id of out.missing)
    logger.info(`  ❓ LOST (never graded across ${out.attempts} attempts): ${id}`)
}

/** ADR-0536 §6 — full-remote mode (remote patch-gen + grading). Runs the AGENT
 *  on a credential-bearing box; gated behind --allow-remote-secrets. The executor
 *  ships ONLY the stripped short-lived access_token over ssh STDIN (refresh/id
 *  dropped), enforces IMDSv2 hop-1 + TTL, and always terminates. --dry-run plans
 *  it safely without launching. Instance-aware relaunch recovers box loss. */
const cmdGradeFullRemote = async (): Promise<void> => {
  if (!hasFlag("--allow-remote-secrets")) {
    logger.info(
      "refused: --mode full runs patch-gen on the remote box and needs an LLM credential there. " +
        "Re-run with --allow-remote-secrets to acknowledge the risk (ADR-0536 §6). " +
        "Tip: --dry-run shows the plan without launching or shipping anything.",
    )
    process.exit(2)
  }
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  if (dataset === undefined) {
    logger.info(
      "usage: quanta-bench grade --mode full --allow-remote-secrets --dataset <instances.jsonl> [--instance id] [--dry-run] [--allow-extra-boxes]",
    )
    process.exit(2)
  }
  const dry = hasFlag("--dry-run")
  // Only read the on-disk credential when actually launching (dry-run never
  // touches it). Stripped to access_token only inside the executor.
  //
  // jun-20: the credential path is overridable via `QUANTA_BENCH_AUTH_FILE` so a
  // SECOND ChatGPT account can drive a parallel full-remote fleet without sharing
  // the default account's rate-limit budget. Symptom that forced this: two
  // concurrent bench efforts on ONE OAuth token starved each other → sustained
  // 429 surfacing as `generation_error` ("LLM stream failed after retries") on
  // BOTH. Point each fleet at its own account file to decouple the rate limits.
  // jun-20 multi-auth: resolve through the SAME source abstraction `pool` uses,
  // so full-remote can't silently diverge to a different auth truth. Single-auth
  // stays byte-identical; pool mode now also honors fail-fast `--auth-label`.
  const authSource = resolveCliAuthSource()
  const authFile = resolveAuthLaunchFile(authSource)
  const authJson = dry ? "{}" : await refreshRemoteAuthJson(authFile)
  const instance = argValue("--instance")
  const preset = resolveBenchExecutionPreset({
    envVars: process.env,
    argvPreset: argValue("--preset"),
  })
  const fullModel = argValue("--model")
  // The expected instance set instance-aware relaunch reconciles against to detect
  // partial loss. `--instance` wins; else every instance_id in the dataset jsonl.
  const expected =
    instance !== undefined
      ? instance
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : readDatasetInstanceIds(dataset)
  // HARD GUARD: `--keep` forces 0 relaunches — a kept box is NOT auto-terminated
  // on loss, so relaunching would orphan it (runaway spot billing). Also 0 when
  // the expected set is unknown (can't reconcile what's missing).
  const maxRelaunch =
    hasFlag("--keep") || expected.length === 0 ? 0 : runtimeConfig().fullRemoteRelaunch
  // ON-DEMAND escape hatch for spot capacity crunches (QUANTA_FULL_REMOTE_ONDEMAND
  // =1). Spot is ~3× cheaper but AWS reclaims it under pressure — observed
  // reclaiming c7i boxes in 4–17 min, faster than relaunch can recover. Same
  // process.env-read pattern as QUANTA_FULL_REMOTE_CONCURRENCY.
  const onDemand = gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND")
  // AMI override (`--ami <id>` or QUANTA_FULL_REMOTE_AMI). Without this the prebaked
  // AMI could not be selected from the CLI — it was baked but unreachable, so every
  // run fell back to the hardcoded default. Now selectable per-run.
  const amiOverride = argValue("--ami") ?? process.env.QUANTA_FULL_REMOTE_AMI
  const makeBackend = (ids: readonly string[]) =>
    createFullRemoteBackend({
      repoDir: process.cwd(),
      authJson,
      datasetPath: dataset,
      ...(ids.length > 0 ? { instanceIds: [...ids] } : {}),
      preset,
      ...(fullModel !== undefined ? { model: fullModel } : {}),
      ...(amiOverride !== undefined && amiOverride !== "" ? { ami: amiOverride } : {}),
      dryRun: dry,
      keep: hasFlag("--keep"),
      allowExtraBoxes: allowExtraBoxes(),
      onDemand,
      onLog: (m) => logger.info(m),
    })
  if (dry) {
    const res = await makeBackend(expected).run()
    printBlock(
      [
        "=== full-remote plan (dry-run) ===",
        describeAuthSource(authSource),
        ...(res.plan ?? []),
      ].join("\n"),
    )
    return
  }
  if (expected.length === 0) {
    // Unknown expected set ⇒ no instance-aware reconcile possible; run once.
    logger.info("[full-remote] could not determine instance set — relaunch retry disabled")
    const res = await makeBackend([]).run()
    logFullRemoteOutcome({
      resolved: [...(res.resolved ?? [])],
      unresolved: [...(res.unresolved ?? [])],
      missing: [],
      attempts: 1,
    })
    return
  }
  const out = await runWithRelaunch(makeBackend, {
    expected,
    maxRelaunch,
    onLog: (m) => logger.info(m),
  })
  logFullRemoteOutcome(out)
}

/** Patch-gen concurrency on the box, clamped [1,16]. The binding limit is the
 *  SHARED OAuth rate, not box CPU, so the DEFAULT is a GLOBAL budget of 16
 *  spread across all boxes in this pool. An explicit env override still wins. */
const poolConcurrencyOverrideRaw = (): string | undefined =>
  process.env.QUANTA_FULL_REMOTE_CONCURRENCY ?? process.env.QUANTA_BENCH_CONCURRENCY

const resolvePoolConcurrency = (workers: number): number => {
  const raw = poolConcurrencyOverrideRaw()
  const override = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN
  if (Number.isFinite(override) && override > 0) return clampPatchGenConcurrency(override)
  return clampPatchGenConcurrency(resolveGlobalPatchGenBudget() / Math.max(1, workers))
}

const resolvePoolWorkers = (): number => {
  const workers = Math.max(1, Math.trunc(Number(argValue("--workers")) || 1))
  if (workers > 1 && !allowExtraBoxes()) {
    logger.info(
      `[pool] refusing workers=${workers}: extra boxes are disabled by default. ` +
        "Re-run with --allow-extra-boxes or QUANTA_ALLOW_EXTRA_BOXES=1.",
    )
    process.exit(2)
  }
  return workers
}

/** Filesystem-safe runId from a chunk dataset path basename. `wave3-s0.jsonl` →
 *  `wave3-s0`. Non-`[A-Za-z0-9_-]` collapse to `_` so the box-side `~/runs/<id>`
 *  dir is always a single safe segment. */
const runIdFromDataset = (path: string): string => {
  const base = (path.split("/").pop() ?? path).replace(/\.jsonl?$/i, "")
  return base.replace(/[^A-Za-z0-9_-]+/g, "_") || "chunk"
}

/** Allocate UNIQUE pool chunk runIds from dataset paths. Basenames may collide
 *  (`a/same.jsonl`, `b/same.jsonl`) — suffix duplicates deterministically so the
 *  box-side `~/runs/<runId>/...` dirs and the pool's per-runId result map never
 *  collide. */
const buildPoolChunks = (datasetPaths: readonly string[]): PoolChunk[] => {
  const seen = new Map<string, number>()
  return datasetPaths.map((datasetPath) => {
    const base = runIdFromDataset(datasetPath)
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    return {
      runId: nth === 1 ? base : `${base}_${nth}`,
      datasetPath,
    }
  })
}

/**
 * jun-20 multi-auth (T-4): the `--chunk-size N` operator escape hatch. When set,
 * each dataset is split into N-instance microchunks so chunk-level account
 * routing approximates per-PROBLEM parallelism (chunkSize=1 ⇒ one problem per
 * chunk) — no per-instance auth surgery inside `bench run`. Returns undefined
 * when the flag is absent (callers fall back to whole-dataset chunks).
 */
const microchunkSizeArg = (): number | undefined => {
  const raw = argValue("--chunk-size")
  if (raw === undefined || raw.trim() === "") return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    logger.info(`refused: --chunk-size must be a positive integer (got "${raw}")`)
    process.exit(2)
  }
  return n
}

const microchunkToPoolChunk = (m: Microchunk): PoolChunk => ({
  runId: m.runId,
  datasetPath: m.datasetPath,
  ...(m.instanceIds.length > 0 ? { instanceIds: [...m.instanceIds] } : {}),
})

/**
 * Resolve the pool's chunk list: whole-dataset chunks by default, or microchunks
 * when `--chunk-size` is set. In dry-run, microchunks are PLANNED only (no slice
 * files written); a real run materializes them on disk.
 */
const resolvePoolChunks = (datasets: readonly string[], dryRun: boolean): PoolChunk[] => {
  const size = microchunkSizeArg()
  if (size === undefined) return buildPoolChunks(datasets)
  const outDirOverride = argValue("--microchunk-dir")
  const chunks: PoolChunk[] = []
  for (const ds of datasets) {
    const outDir = outDirOverride ?? defaultMicrochunkDir(ds)
    if (dryRun) {
      const base = runIdFromDataset(ds)
      const planned = planMicrochunks(readFileSync(ds, "utf8"), base, size)
      for (const p of planned) {
        chunks.push(
          microchunkToPoolChunk({
            runId: p.runId,
            datasetPath: join(outDir, `${p.runId}.jsonl`),
            instanceIds: p.instanceIds,
          }),
        )
      }
    } else {
      for (const m of writeMicrochunks({ datasetPath: ds, chunkSize: size, outDir })) {
        chunks.push(microchunkToPoolChunk(m))
      }
    }
  }
  return chunks
}

const requirePoolDatasets = (): string[] => {
  const datasetsArg = argValue("--datasets")
  if (datasetsArg === undefined || datasetsArg.trim() === "") {
    logger.info(
      "usage: quanta-bench pool --allow-remote-secrets --datasets <c1.jsonl,c2.jsonl,…> [--workers 1] [--wait-for-idle] [--wait-timeout-min N] [--allow-extra-boxes] [--model m] [--ami id]",
    )
    process.exit(2)
  }
  return datasetsArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
}

const poolConcurrencySource = (override: string | undefined): string =>
  override !== undefined &&
  override !== "" &&
  Number.isFinite(Number(override)) &&
  Number(override) > 0
    ? "env override"
    : `default shared budget=${resolveGlobalPatchGenBudget()}`

/**
 * jun-20 box-lifecycle Phase 2/3 — persistent-pool full-remote. Bootstraps ONE
 * box (or `--workers N`) ONCE and feeds it a QUEUE of dataset chunks, instead of
 * re-paying the boot+rsync+install+warm tax per wave. Each chunk re-ships a FRESH
 * token and writes to a runId-scoped box dir; a chunk whose box died is requeued.
 *
 *   quanta-bench pool --allow-remote-secrets --datasets c1.jsonl,c2.jsonl[,…] [--workers 1]
 *   quanta-bench pool … --wait-for-idle              # park until the warm box goes idle, then reuse/launch
 *   quanta-bench pool … --workers 2 --allow-extra-boxes   # explicit multi-box opt-in
 */
/**
 * jun-20 multi-auth (T-3): a per-account lease provider for `pool`, or undefined
 * in single-auth mode (so the legacy `authJsonProvider` path stays unchanged).
 * Each account's token file is read FRESH at ship time (never cached, never the
 * long-lived secret — `gradeChunkOnBox` strips it to access_token).
 */
const buildPoolAuthProvider = (src: AuthSource): PoolAuthProvider | undefined => {
  if (src.kind === "single") return undefined
  const manager = new AuthLeaseManager(src.accounts)
  return createLeasePoolAuthProvider(manager, (path) => readFileSync(path, "utf8"))
}

const refreshPoolAuthSource = async (src: AuthSource): Promise<void> => {
  const files = src.kind === "single" ? [src.authFile] : src.accounts.map((a) => a.authFile)
  for (const file of [...new Set(files)]) {
    await refreshRemoteAuthJson(file)
  }
}

/**
 * jun-20 multi-auth (T-3): a representative per-chunk → account plan for dry-run.
 * Simulates least-loaded spreading (each chunk takes one slot, none released) so
 * the operator can see how chunks fan across accounts. Approximate — real routing
 * also factors warm-box affinity and live cooldowns. Empty in single-auth mode.
 */
const planPoolChunkAccounts = (src: AuthSource, chunks: readonly PoolChunk[]): string[] => {
  if (src.kind === "single") return []
  const mgr = new AuthLeaseManager(src.accounts)
  return chunks.map((c) => {
    const lease = mgr.acquire({ runId: c.runId, requestedSlots: 1 })
    return lease === null
      ? `  plan ${c.runId} -> (all accounts saturated — queued until a slot frees)`
      : `  plan ${c.runId} -> ${lease.accountLabel}`
  })
}

const cmdPool = async (): Promise<void> => {
  if (!hasFlag("--allow-remote-secrets")) {
    logger.info(
      "refused: pool runs patch-gen on remote boxes and needs an LLM credential there. " +
        "Re-run with --allow-remote-secrets to acknowledge the risk (ADR-0536 §6).",
    )
    process.exit(2)
  }
  const datasets = requirePoolDatasets()
  const chunks = resolvePoolChunks(datasets, hasFlag("--dry-run"))
  const workers = resolvePoolWorkers()
  // jun-20 multi-auth (T-1): resolve EITHER the legacy single account or a
  // multi-account pool. T-3 schedules per-chunk leases off this; until then the
  // launch path stays single-account (byte-identical when no pool configured).
  const authSource = resolveCliAuthSource()
  const authFile = resolveAuthLaunchFile(authSource)
  if (!hasFlag("--dry-run")) await refreshPoolAuthSource(authSource)
  const preset = resolveBenchExecutionPreset({
    envVars: process.env,
    argvPreset: argValue("--preset"),
  })
  const model = argValue("--model") ?? "gpt-5.4"
  const amiOverride = argValue("--ami") ?? process.env.QUANTA_FULL_REMOTE_AMI
  const onDemand = gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND")
  const concurrency = resolvePoolConcurrency(workers)
  const extraBoxes = allowExtraBoxes()
  const waitForIdle = waitForIdleBox()
  const waitTimeoutMs = positiveMinutesFlagMs("--wait-timeout-min")
  const concurrencyOverride = poolConcurrencyOverrideRaw()
  const concurrencySource = poolConcurrencySource(concurrencyOverride)
  const recordTrajectory =
    process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== undefined &&
    process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== "" &&
    process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== "0"
  logger.info(
    `[pool] ${chunks.length} chunk(s) across ${workers} box(es); per-box patch-gen concurrency=${concurrency} (${concurrencySource})`,
  )
  if (hasFlag("--dry-run")) {
    printBlock(
      [
        "=== pool plan (dry-run) ===",
        describeAuthSource(authSource),
        ...(microchunkSizeArg() !== undefined
          ? [`microchunks: ${chunks.length} chunk(s) at chunk-size=${microchunkSizeArg()}`]
          : []),
        `workers=${workers}  preset=${preset}  model=${model}  concurrency=${concurrency}  onDemand=${onDemand}  waitForIdle=${waitForIdle}`,
        ...chunks.map((c) => `chunk ${c.runId} ← ${c.datasetPath}  (box dir ~/runs/${c.runId}/)`),
        ...planPoolChunkAccounts(authSource, chunks),
        "would reuse a warm idle box or provision one, grade each chunk SERIALLY, fetch reports, leave warm.",
      ].join("\n"),
    )
    return
  }
  const wallMin = argValue("--max-box-wall-min")
  const out = await runPool(chunks, {
    provision: {
      repoDir: process.cwd(),
      authJson: "{}", // unused for provisioning; the per-chunk provider ships the real token
      datasetPath: datasets[0] ?? "",
      launchMode: "pool",
      preset,
      model,
      ...(amiOverride !== undefined && amiOverride !== "" ? { ami: amiOverride } : {}),
      onDemand,
      keep: hasFlag("--keep"),
      onLog: (m) => logger.info(m),
    },
    workers,
    allowExtraWorkers: workers > 1,
    allowExtraBoxes: extraBoxes,
    waitForIdle,
    ...(waitTimeoutMs !== undefined ? { waitForIdleTimeoutMs: waitTimeoutMs } : {}),
    preset,
    model,
    concurrency,
    ...(wallMin !== undefined ? { maxBoxWallMs: Math.max(0, Number(wallMin) || 0) * 60_000 } : {}),
    // FRESH token per chunk — a long pool run never grades on a stale access_token.
    // Single-auth fallback; in pool mode `authProvider` below drives per-chunk leasing.
    authJsonProvider: () => readFileSync(authFile, "utf8"),
    // jun-20 multi-auth (T-3): per-account lease scheduler in pool mode (else undefined).
    ...(() => {
      const p = buildPoolAuthProvider(authSource)
      return p !== undefined ? { authProvider: p } : {}
    })(),
    forwardedBenchEnv: buildForwardedBenchEnv(process.env),
    recordTrajectory,
    onLog: (m) => logger.info(m),
  })
  summarizePoolRun(out, chunks.length)
}

export const summarizePoolRunLines = (
  out: Awaited<ReturnType<typeof runPool>>,
  chunkCount: number,
): string[] => {
  let resolved = 0
  let lost = 0
  let partial = 0
  const lines: string[] = []
  for (const r of out) {
    resolved += r.result.resolved?.length ?? 0
    if (r.lost) lost += 1
    const missing = r.missing?.length ?? 0
    if (!r.lost && missing > 0) partial += 1
    const tag = r.lost ? "❓ LOST" : missing > 0 ? "⚠️ PARTIAL" : "ok"
    lines.push(
      `[pool] chunk ${r.chunk.runId}: ${tag} — resolved ${r.result.resolved?.length ?? 0} | unresolved ${r.result.unresolved?.length ?? 0} | missing ${missing} | attempts ${r.attempts}`,
    )
    for (const id of r.missing ?? []) lines.push(`[pool]   ❓ MISSING ${id}`)
  }
  lines.push(
    `[pool] DONE — total resolved ${resolved} across ${chunkCount} chunks; ${lost} lost; ${partial} partial`,
  )
  return lines
}

/** Print the per-chunk + total outcome of a pool run. */
const summarizePoolRun = (out: Awaited<ReturnType<typeof runPool>>, chunkCount: number): void => {
  for (const line of summarizePoolRunLines(out, chunkCount)) logger.info(line)
}

/**
 * jun-20 multi-auth (T-6): `quanta-bench auth status [--auth-pool m] [--json]`.
 * Shows the operator the resolved auth roster — labels and per-account capacity
 * (maxParallel / maxBoxes / weight / disabled) — so a multi-account fleet can be
 * run without guessing which accounts exist or how much each can take. This is
 * the STATIC allocation view from the manifest; live cooldown/activeSlots surface
 * through the per-box status snapshots (`box ls`). NEVER prints token material:
 * the resolver only ever holds file PATHS, never reads a credential.
 */
/**
 * jun-20 multi-auth (T-7): `quanta-bench auth login --auth-label <label>`. Runs
 * the SAME ChatGPT OAuth flow as the main CLI's `/login`, writes the token to a
 * per-label file, and auto-registers the account in the pool manifest — closing
 * the loop the fleet previously lacked (it could consume per-account files but
 * nothing produced the extra ones). OAuth errors propagate to `main().catch` (exit 1).
 */
const cmdAuthLogin = async (): Promise<void> => {
  const label = argValue("--auth-label")
  if (label === undefined || label.trim() === "") {
    logger.info(
      "usage: quanta-bench auth login --auth-label <label> [--auth-file <path>] [--auth-pool <manifest>] [--max-parallel N]",
    )
    process.exit(2)
  }
  const authFile = argValue("--auth-file")
  const manifestPath = argValue("--auth-pool") ?? process.env.QUANTA_BENCH_AUTH_POOL
  const maxParallelRaw = argValue("--max-parallel")
  const res = await runBenchLogin(
    {
      label,
      ...(authFile !== undefined ? { authFile } : {}),
      ...(manifestPath !== undefined && manifestPath.trim() !== "" ? { manifestPath } : {}),
      ...(maxParallelRaw !== undefined ? { maxParallel: Number(maxParallelRaw) } : {}),
    },
    { env: process.env, onLog: (m) => logger.info(m) },
  )
  printBlock(
    [
      `✓ signed in account "${res.label}" (plan: ${res.plan})`,
      `  token:    ${res.authFile}`,
      `  manifest: ${res.manifestPath} (${res.manifestAdded ? "added" : "already present"}; ${res.accountCount} account(s))`,
      `  run with: QUANTA_BENCH_AUTH_POOL=${res.manifestPath} quanta-bench pool --allow-remote-secrets …`,
    ].join("\n"),
  )
}

const cmdAuth = async (): Promise<void> => {
  const action = positionals()[0]
  if (action === "login") {
    await cmdAuthLogin()
    return
  }
  if (action !== "status") {
    logger.info(
      "usage: quanta-bench auth (status|login) [--auth-pool <manifest>] [--auth-label <label>] [--json]",
    )
    process.exit(2)
  }
  const src = resolveCliAuthSource()
  const json = hasFlag("--json")
  if (src.kind === "single") {
    printBlock(
      json
        ? JSON.stringify({ mode: "single", authFile: src.authFile })
        : `auth: single account\n  file: ${src.authFile}`,
    )
    return
  }
  const rows = src.accounts.map((a) => ({
    label: a.label,
    maxParallel: a.maxParallel,
    maxBoxes: a.maxBoxes ?? null,
    weight: a.weight ?? 1,
    disabled: a.disabled === true,
  }))
  if (json) {
    printBlock(JSON.stringify({ mode: "pool", accounts: rows }, null, 2))
    return
  }
  printBlock(
    [
      `auth: pool of ${rows.length} account(s)`,
      ...rows.map(
        (r) =>
          `  ${r.disabled ? "✕" : "•"} ${r.label}  maxParallel=${r.maxParallel}  maxBoxes=${
            r.maxBoxes ?? "∞"
          }  weight=${r.weight}${r.disabled ? "  (disabled)" : ""}`,
      ),
    ].join("\n"),
  )
}

/**
 * jun-20 box-lifecycle — `bench box` manages the WARM box pool that `pool` now
 * leaves alive for reuse. Boxes are SPOT (reclaimable) + TTL-self-terminating, so
 * this is for visibility + manual cleanup of lingerers, plus pre-warming.
 *
 *   quanta-bench box ls                  # list running quanta-bench boxes + runtime status
 *   quanta-bench box ls --json           # same, machine-readable
 *   quanta-bench box status              # operator summary + suggested follow target
 *   quanta-bench box rm <iid|all>        # terminate a box (or all of them)
 *   quanta-bench box up                  # provision + bootstrap ONE warm box, leave it alive
 */
const BOX_TAG_FILTERS = [
  "--filters",
  "Name=tag:Name,Values=quanta-bench-full",
  "Name=instance-state-name,Values=running,pending",
]

const awsText = async (
  region: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> => {
  const p = Bun.spawn(["aws", "--region", region, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, out, err }
}

interface BoxLsRow {
  readonly iid: string
  readonly state: string
  readonly launchTime: string
  readonly ip: string
  readonly instanceType: string
  readonly launchMode?: string
  readonly launchPreset?: string
  readonly launchModel?: string
  readonly launchDataset?: string
  readonly launchSelection?: string
}

interface BoxRuntimeRow extends BoxLsRow, Awaited<ReturnType<typeof inspectBox>> {
  readonly snapshotAgeSec?: number
  readonly runAgeSec?: number
  readonly logPath?: string
  readonly logAgeSec?: number
  readonly freshness: "fresh" | "stale" | "unknown"
  readonly statusSource: "snapshot" | "probe" | "launch-tags" | "none"
  readonly followHint: string
}

interface BoxStatusSummary {
  readonly total: number
  readonly busy: number
  readonly idle: number
  readonly bootstrapping: number
  readonly unreachable: number
  readonly stale: number
  readonly snapshotIssues: number
  readonly snapshotStateCounts: Partial<
    Record<Awaited<ReturnType<typeof inspectBox>>["snapshotState"], number>
  >
  readonly target?: string
  readonly targetFollowHint?: string
}

const DEFAULT_BOX_LOG_PATH = "~/run.log"
const BUSY_SNAPSHOT_STALE_SEC = 180
const IDLE_SNAPSHOT_STALE_SEC = 900

const parseBoxLsRows = (out: string): BoxLsRow[] =>
  out
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [
        iid = "",
        state = "",
        launchTime = "",
        ip = "",
        instanceType = "",
        launchMode = "",
        launchPreset = "",
        launchModel = "",
        launchDataset = "",
        launchSelection = "",
      ] = line.split(/\s+/)
      return {
        iid,
        state,
        launchTime,
        ip,
        instanceType,
        ...(launchMode !== "" && launchMode !== "None" ? { launchMode } : {}),
        ...(launchPreset !== "" && launchPreset !== "None" ? { launchPreset } : {}),
        ...(launchModel !== "" && launchModel !== "None" ? { launchModel } : {}),
        ...(launchDataset !== "" && launchDataset !== "None" ? { launchDataset } : {}),
        ...(launchSelection !== "" && launchSelection !== "None" ? { launchSelection } : {}),
      }
    })
    .filter((row) => row.iid.startsWith("i-"))

const hasLaunchTags = (
  row: Pick<
    BoxLsRow,
    "launchMode" | "launchPreset" | "launchModel" | "launchDataset" | "launchSelection"
  >,
): boolean =>
  row.launchMode !== undefined ||
  row.launchPreset !== undefined ||
  row.launchModel !== undefined ||
  row.launchDataset !== undefined ||
  row.launchSelection !== undefined

const parseIsoMs = (s: string | undefined): number | undefined => {
  if (s === undefined || s === "") return undefined
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : undefined
}

const ageSecondsFromIso = (s: string | undefined): number | undefined => {
  const ms = parseIsoMs(s)
  if (ms === undefined) return undefined
  return Math.max(0, Math.round((Date.now() - ms) / 1000))
}

const boxStatusSource = (
  row: BoxLsRow,
  inspection: Pick<Awaited<ReturnType<typeof inspectBox>>, "snapshot" | "probe">,
): BoxRuntimeRow["statusSource"] =>
  inspection.snapshot !== undefined
    ? "snapshot"
    : inspection.probe !== undefined
      ? "probe"
      : hasLaunchTags(row)
        ? "launch-tags"
        : "none"

const boxFreshness = (
  lifecycle: BoxRuntimeRow["lifecycle"],
  snapshotAgeSec: number | undefined,
  probe: Awaited<ReturnType<typeof inspectBox>>["probe"],
  logAgeSec: number | undefined,
): BoxRuntimeRow["freshness"] => {
  if (snapshotAgeSec !== undefined) {
    const budgetSec = lifecycle === "busy" ? BUSY_SNAPSHOT_STALE_SEC : IDLE_SNAPSHOT_STALE_SEC
    return snapshotAgeSec > budgetSec ? "stale" : "fresh"
  }
  if (probe?.activeRunDetected === true) return "fresh"
  if (logAgeSec === undefined) return "unknown"
  const budgetSec = lifecycle === "busy" ? BUSY_SNAPSHOT_STALE_SEC : IDLE_SNAPSHOT_STALE_SEC
  return logAgeSec > budgetSec ? "stale" : "fresh"
}

const listBenchBoxes = async (region: string, keyPath: string): Promise<BoxRuntimeRow[]> => {
  const r = await awsText(region, [
    "ec2",
    "describe-instances",
    ...BOX_TAG_FILTERS,
    "--query",
    "Reservations[].Instances[].[InstanceId,State.Name,LaunchTime,PublicIpAddress,InstanceType,Tags[?Key=='QuantaMode']|[0].Value,Tags[?Key=='QuantaPreset']|[0].Value,Tags[?Key=='QuantaModel']|[0].Value,Tags[?Key=='QuantaDataset']|[0].Value,Tags[?Key=='QuantaSelection']|[0].Value]",
    "--output",
    "text",
  ])
  if (r.code !== 0) {
    logger.info(`[box] describe failed: ${r.err.trim()}`)
    process.exit(1)
  }
  const rows = parseBoxLsRows(r.out)
  if (rows.length === 0) return []
  const baseCfg = {
    repoDir: process.cwd(),
    authJson: "{}",
    datasetPath: "",
    region,
    keyPath,
  }
  const inspections: Awaited<ReturnType<typeof inspectBox>>[] = await Promise.all(
    rows.map(async (row) => {
      if (row.state !== "running" || row.ip === "" || row.ip === "None") {
        return {
          lifecycle: "bootstrapping",
          bootstrapped: false,
          busy: false,
          snapshotHealthy: false,
          snapshotState: "not-ready",
        }
      }
      return inspectBox(baseCfg, { iid: row.iid, ip: row.ip }).catch(() => ({
        lifecycle: "unreachable",
        bootstrapped: false,
        busy: false,
        snapshotHealthy: false,
        snapshotState: "read-failed",
      }))
    }),
  )
  return rows.map((row, i) => {
    const inspection = inspections[i] ?? {
      lifecycle: "unreachable",
      bootstrapped: false,
      busy: false,
      snapshotHealthy: false,
      snapshotState: "read-failed",
    }
    const snapshot = inspection.snapshot
    const probe = inspection.probe
    const snapshotAgeSec = ageSecondsFromIso(snapshot?.updatedAt)
    const runAgeSec = ageSecondsFromIso(snapshot?.startedAt)
    const logPath = boxRunLogPath(snapshot) ?? probe?.runLogPath
    const logAgeSec = ageSecondsFromIso(probe?.runLogUpdatedAt)
    return {
      ...row,
      ...inspection,
      ...(snapshotAgeSec !== undefined ? { snapshotAgeSec } : {}),
      ...(runAgeSec !== undefined ? { runAgeSec } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
      ...(logAgeSec !== undefined ? { logAgeSec } : {}),
      freshness: boxFreshness(inspection.lifecycle, snapshotAgeSec, probe, logAgeSec),
      statusSource: boxStatusSource(row, inspection),
      followHint: `bun run src/apps/bench/cli.ts box logs ${row.iid} --follow`,
    }
  })
}

const latestLaunchFirst = (rows: readonly BoxRuntimeRow[]): BoxRuntimeRow[] =>
  [...rows].sort(
    (a, b) =>
      (parseIsoMs(b.launchTime) ?? Number.NEGATIVE_INFINITY) -
      (parseIsoMs(a.launchTime) ?? Number.NEGATIVE_INFINITY),
  )

const resolveBoxTarget = (
  rows: readonly BoxRuntimeRow[],
  raw: string | undefined,
): BoxRuntimeRow => {
  if (rows.length === 0) {
    throw new Error("[box] no running quanta-bench boxes")
  }
  const target = raw?.trim()
  if (target === undefined || target === "" || target === "auto") {
    const busy = latestLaunchFirst(rows.filter((row) => row.lifecycle === "busy"))
    if (busy[0] !== undefined) return busy[0]
    return latestLaunchFirst(rows)[0] as BoxRuntimeRow
  }
  if (target === "latest") return latestLaunchFirst(rows)[0] as BoxRuntimeRow
  if (target === "busy") {
    const busy = latestLaunchFirst(rows.filter((row) => row.lifecycle === "busy"))
    if (busy[0] === undefined) throw new Error("[box] no busy box is currently running")
    return busy[0]
  }
  const exact = rows.find((row) => row.iid === target)
  if (exact !== undefined) return exact
  const pref = rows.filter((row) => row.iid.startsWith(target))
  if (pref.length === 1) return pref[0] as BoxRuntimeRow
  if (pref.length > 1) {
    throw new Error(
      `[box] ambiguous box target "${target}" — matches: ${pref.map((row) => row.iid).join(", ")}`,
    )
  }
  throw new Error(`[box] box "${target}" not found`)
}

const summarizeBenchBoxes = (rows: readonly BoxRuntimeRow[]): BoxStatusSummary => {
  const snapshotStateCounts = rows.reduce<
    Partial<Record<Awaited<ReturnType<typeof inspectBox>>["snapshotState"], number>>
  >((acc, row) => {
    if (row.snapshotHealthy) return acc
    acc[row.snapshotState] = (acc[row.snapshotState] ?? 0) + 1
    return acc
  }, {})
  if (rows.length === 0) {
    return {
      total: 0,
      busy: 0,
      idle: 0,
      bootstrapping: 0,
      unreachable: 0,
      stale: 0,
      snapshotIssues: 0,
      snapshotStateCounts,
    }
  }
  const target = resolveBoxTarget(rows, "auto")
  return {
    total: rows.length,
    busy: rows.filter((row) => row.lifecycle === "busy").length,
    idle: rows.filter((row) => row.lifecycle === "idle").length,
    bootstrapping: rows.filter((row) => row.lifecycle === "bootstrapping").length,
    unreachable: rows.filter((row) => row.lifecycle === "unreachable").length,
    stale: rows.filter((row) => row.freshness === "stale").length,
    snapshotIssues: rows.filter((row) => !row.snapshotHealthy).length,
    snapshotStateCounts,
    target: target.iid,
    targetFollowHint: target.followHint,
  }
}

const boxStatusLabel = (row: BoxRuntimeRow): string =>
  `${row.lifecycle}${row.snapshot?.phase !== undefined ? `/${row.snapshot.phase}` : ""}${
    row.freshness === "stale" ? "/stale" : ""
  }`

const snapshotHealthDetail = (
  row: Pick<BoxRuntimeRow, "snapshotHealthy" | "snapshotState">,
): string => (row.snapshotHealthy ? "  snapshot=ok" : `  snapshot=${row.snapshotState}`)

const yesNo = (value: boolean | undefined): string =>
  value === true ? "yes" : value === false ? "no" : "unknown"

const boxSnapshotDetailLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot === undefined) return undefined
  return `  source=snapshot  mode=${row.snapshot.mode}${row.snapshot.accountLabel !== undefined ? `  account=${row.snapshot.accountLabel}` : ""}  workload=${row.snapshot.runId ?? row.snapshot.workload}  dataset=${row.snapshot.dataset}  instances=${row.snapshot.instanceCount}  preset=${row.snapshot.preset}  model=${row.snapshot.model}  conc=${row.snapshot.concurrency}  updated=${row.snapshot.updatedAt}${row.snapshotAgeSec !== undefined ? ` (${row.snapshotAgeSec}s ago)` : ""}`
}

const boxProbeDetailLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.probe === undefined) return undefined
  return `  source=probe${snapshotHealthDetail(row)}  active=${yesNo(row.probe.activeRunDetected)}  report=${yesNo(row.probe.reportExists)}  runExit=${yesNo(row.probe.runExitExists)}${row.probe.predictionsLines !== undefined ? `  preds=${row.probe.predictionsLines}` : ""}`
}

const boxLaunchTagDetailLine = (row: BoxRuntimeRow): string | undefined => {
  if (!hasLaunchTags(row)) return undefined
  return `  source=launch-tags${snapshotHealthDetail(row)}${row.launchMode !== undefined ? `  mode=${row.launchMode}` : ""}${row.launchPreset !== undefined ? `  preset=${row.launchPreset}` : ""}${row.launchModel !== undefined ? `  model=${row.launchModel}` : ""}${row.launchDataset !== undefined ? `  dataset=${row.launchDataset}` : ""}${row.launchSelection !== undefined ? `  selection=${row.launchSelection}` : ""}`
}

const boxDetailLine = (row: BoxRuntimeRow): string | undefined =>
  boxSnapshotDetailLine(row) ?? boxProbeDetailLine(row) ?? boxLaunchTagDetailLine(row)

const boxLaunchHeaderLine = (row: BoxRuntimeRow): string | undefined =>
  row.snapshot === undefined && row.probe === undefined && hasLaunchTags(row)
    ? boxDetailLine(row)
    : undefined

const boxRuntimeLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot !== undefined) {
    return `  started=${row.snapshot.startedAt ?? "unknown"}${row.runAgeSec !== undefined ? `  runtime=${row.runAgeSec}s` : ""}${row.logPath !== undefined ? `  logPath=${row.logPath}` : ""}`
  }
  if (row.probe === undefined) return undefined
  return `${row.logPath !== undefined ? `  logPath=${row.logPath}` : "  logPath=unknown"}${
    row.probe.runLogUpdatedAt !== undefined
      ? `  logUpdated=${row.probe.runLogUpdatedAt}${row.logAgeSec !== undefined ? ` (${row.logAgeSec}s ago)` : ""}`
      : ""
  }`
}

const boxOutcomeLine = (row: BoxRuntimeRow): string | undefined =>
  row.snapshot?.resolvedCount !== undefined ||
  row.snapshot?.unresolvedCount !== undefined ||
  row.snapshot?.erroredCount !== undefined ||
  row.snapshot?.emptyPatchCount !== undefined ||
  row.snapshot?.rateLimited === true
    ? `  outcome=resolved:${row.snapshot?.resolvedCount ?? 0} unresolved:${row.snapshot?.unresolvedCount ?? 0} errored:${row.snapshot?.erroredCount ?? 0} empty:${row.snapshot?.emptyPatchCount ?? 0}${row.snapshot?.rateLimited === true ? "  rateLimited=yes" : ""}`
    : undefined

const renderBoxRow = (row: BoxRuntimeRow): string[] => {
  const headline = `${row.iid}  ${row.state}  ${row.instanceType}  ${row.ip}  status=${boxStatusLabel(row)}`
  return [
    headline,
    `  launched=${row.launchTime}`,
    boxDetailLine(row),
    boxRuntimeLine(row),
    boxOutcomeLine(row),
    row.snapshot?.lastLogLine !== undefined
      ? `  log=${row.snapshot.lastLogLine}`
      : row.probe?.lastLogLine !== undefined
        ? `  log=${row.probe.lastLogLine}`
        : undefined,
    row.logPath !== undefined ? `  follow=${row.followHint}` : undefined,
  ].filter((line): line is string => line !== undefined)
}

const renderBoxList = (rows: readonly BoxRuntimeRow[]): string =>
  ["[box] running boxes:", ...latestLaunchFirst(rows).flatMap((row) => renderBoxRow(row))].join(
    "\n",
  )

const renderPatchGenBudgetLine = (budget: PatchGenBudgetState): string => {
  const holders =
    budget.leases.length === 0
      ? "none"
      : budget.leases
          .slice(0, 3)
          .map((lease) => `${lease.label}:${lease.units}`)
          .join(", ") + (budget.leases.length > 3 ? ` +${budget.leases.length - 3} more` : "")
  return `  patchGenBudget=${budget.inUse}/${budget.limit}  available=${budget.available}  holders=${budget.leases.length}  leases=${holders}`
}

const renderPatchGenBudgetErrorLine = (error: string): string =>
  `  patchGenBudget=unavailable  error=${error}`

const SNAPSHOT_STATE_RENDER_ORDER: ReadonlyArray<
  Awaited<ReturnType<typeof inspectBox>>["snapshotState"]
> = ["write-failed", "read-failed", "invalid", "missing", "not-ready", "ok"]

const renderSnapshotStateCounts = (
  counts: Partial<Record<Awaited<ReturnType<typeof inspectBox>>["snapshotState"], number>>,
): string | undefined => {
  const rendered = SNAPSHOT_STATE_RENDER_ORDER.map((state) => {
    const count = counts[state]
    return count !== undefined && count > 0 ? `${state}:${count}` : undefined
  })
    .filter((entry): entry is string => entry !== undefined)
    .join(",")
  return rendered === "" ? undefined : rendered
}

const renderBoxStatus = (
  summary: BoxStatusSummary,
  rows: readonly BoxRuntimeRow[],
  budget: PatchGenBudgetState | undefined,
  budgetError: string | undefined,
): string => {
  const staleRows = latestLaunchFirst(rows.filter((row) => row.freshness === "stale"))
  const focus =
    latestLaunchFirst(rows.filter((row) => row.lifecycle === "busy"))[0] ??
    latestLaunchFirst(rows)[0]
  return [
    "[box] summary:",
    `  total=${summary.total}  busy=${summary.busy}  idle=${summary.idle}  bootstrapping=${summary.bootstrapping}  unreachable=${summary.unreachable}  stale=${summary.stale}  snapshotIssues=${summary.snapshotIssues}${
      renderSnapshotStateCounts(summary.snapshotStateCounts) !== undefined
        ? `  snapshotStates=${renderSnapshotStateCounts(summary.snapshotStateCounts)}`
        : ""
    }`,
    budget !== undefined ? renderPatchGenBudgetLine(budget) : undefined,
    budget === undefined && budgetError !== undefined
      ? renderPatchGenBudgetErrorLine(budgetError)
      : undefined,
    focus !== undefined
      ? `  target=${focus.iid}  status=${boxStatusLabel(focus)}  source=${focus.statusSource}${snapshotHealthDetail(focus)}${focus.logPath !== undefined ? `  logPath=${focus.logPath}` : ""}${
          focus.logAgeSec !== undefined ? `  logAge=${focus.logAgeSec}s` : ""
        }`
      : undefined,
    summary.targetFollowHint !== undefined ? `  follow=${summary.targetFollowHint}` : undefined,
    ...staleRows.map(
      (row) =>
        `  stale=${row.iid}  status=${boxStatusLabel(row)}  source=${row.statusSource}${snapshotHealthDetail(row)}  updated=${row.snapshot?.updatedAt ?? row.probe?.runLogUpdatedAt ?? "none"}${
          row.snapshotAgeSec !== undefined
            ? ` (${row.snapshotAgeSec}s ago)`
            : row.logAgeSec !== undefined
              ? ` (${row.logAgeSec}s ago)`
              : ""
        }`,
    ),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

const BOX_LOG_MISSING_MARKER = "__QUANTA_LOG_MISSING__"

const boxTailCommand = (logPath: string, lines: number, follow = false): string =>
  `if test -f ${logPath}; then tail -n ${lines}${follow ? " -f" : ""} ${logPath}; else echo "${BOX_LOG_MISSING_MARKER} ${logPath}" >&2; exit 2; fi`

const missingLogPath = (tail: { out: string; err: string }): string | undefined => {
  const match = `${tail.out}\n${tail.err}`.match(/__QUANTA_LOG_MISSING__\s+(\S+)/)
  return match?.[1]
}

const cleanedLogError = (tail: { err: string }): string | undefined => {
  const cleaned = tail.err
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.includes(BOX_LOG_MISSING_MARKER))
    .join("\n")
    .trim()
  return cleaned === "" ? undefined : cleaned
}

const boxDisplayedLastLogLine = (row: BoxRuntimeRow): string | undefined =>
  row.snapshot?.lastLogLine ?? row.probe?.lastLogLine

const boxHeaderUpdatedLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot?.updatedAt !== undefined) {
    return `  updated=${row.snapshot.updatedAt}${row.snapshotAgeSec !== undefined ? ` (${row.snapshotAgeSec}s ago)` : ""}`
  }
  if (row.probe?.runLogUpdatedAt !== undefined) {
    return `  logUpdated=${row.probe.runLogUpdatedAt}${row.logAgeSec !== undefined ? ` (${row.logAgeSec}s ago)` : ""}`
  }
  return undefined
}

const boxHeaderActiveLine = (row: BoxRuntimeRow): string | undefined => {
  if (row.snapshot?.startedAt !== undefined) {
    return `  started=${row.snapshot.startedAt}${row.runAgeSec !== undefined ? `  runtime=${row.runAgeSec}s` : ""}`
  }
  if (row.probe?.activeRunDetected === true) {
    return `  active=yes${row.logAgeSec !== undefined ? `  logAge=${row.logAgeSec}s` : ""}`
  }
  return undefined
}

const renderBoxLogHeader = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string,
  follow: boolean,
): string => {
  return [
    follow ? `[box] following ${row.iid} (${host})` : `[box] ${row.iid}  ${host}`,
    `  status=${boxStatusLabel(row)}`,
    `  source=${row.statusSource}${snapshotHealthDetail(row)}`,
    `  logPath=${logPath}`,
    boxHeaderUpdatedLine(row),
    boxHeaderActiveLine(row),
    boxLaunchHeaderLine(row),
    boxDisplayedLastLogLine(row) !== undefined
      ? `  last=${boxDisplayedLastLogLine(row)}`
      : undefined,
    `  follow=${row.followHint}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

const pendingLogExitCode = (row: BoxRuntimeRow): number =>
  row.lifecycle === "bootstrapping" || row.probe?.activeRunDetected === true ? 0 : 2

const pendingLogMessage = (row: BoxRuntimeRow, logPath: string | undefined): string => {
  if (row.lifecycle === "bootstrapping")
    return "run log not created yet; box is still bootstrapping"
  if (row.probe?.activeRunDetected === true) {
    return `run log not created yet${logPath !== undefined ? ` at ${logPath}` : ""}`
  }
  return `run log not found${logPath !== undefined ? ` at ${logPath}` : ""}`
}

const renderPendingLogJson = (
  row: BoxRuntimeRow,
  logPath: string | undefined,
  lines: number,
  message: string,
  error: string | undefined,
): string =>
  JSON.stringify(
    {
      iid: row.iid,
      ip: row.ip,
      lifecycle: row.lifecycle,
      freshness: row.freshness,
      statusSource: row.statusSource,
      snapshotHealthy: row.snapshotHealthy,
      snapshotState: row.snapshotState,
      logPath,
      lines,
      snapshot: row.snapshot,
      probe: row.probe,
      ...(hasLaunchTags(row)
        ? {
            launchTags: {
              ...(row.launchMode !== undefined ? { mode: row.launchMode } : {}),
              ...(row.launchPreset !== undefined ? { preset: row.launchPreset } : {}),
              ...(row.launchModel !== undefined ? { model: row.launchModel } : {}),
              ...(row.launchDataset !== undefined ? { dataset: row.launchDataset } : {}),
              ...(row.launchSelection !== undefined ? { selection: row.launchSelection } : {}),
            },
          }
        : {}),
      followHint: row.followHint,
      tail: "",
      error,
      pendingLog: true,
      message,
      exitCode: pendingLogExitCode(row),
    },
    null,
    2,
  )

const printPendingLog = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string | undefined,
  lines: number,
  message: string,
): void => {
  if (hasFlag("--json")) {
    printBlock(renderPendingLogJson(row, logPath, lines, message, undefined))
    if (pendingLogExitCode(row) !== 0) process.exit(pendingLogExitCode(row))
    return
  }
  printBlock(
    [
      renderBoxLogHeader(row, host, logPath ?? DEFAULT_BOX_LOG_PATH, false),
      `--- tail -n ${lines} ---`,
      message,
    ].join("\n"),
  )
  if (pendingLogExitCode(row) !== 0) process.exit(pendingLogExitCode(row))
}

const pendingBootstrappingLog = (row: BoxRuntimeRow): boolean =>
  row.lifecycle === "bootstrapping" && row.logPath === undefined

const pendingBootstrappingHost = (row: BoxRuntimeRow): string =>
  row.ip === "" || row.ip === "None" ? "ssh-pending" : `ubuntu@${row.ip}`

const handleMissingLogTail = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string,
  lines: number,
  tail: { out: string; err: string },
): boolean => {
  const pendingLogPath = missingLogPath(tail)
  if (pendingLogPath === undefined) return false
  const message = pendingLogMessage(row, pendingLogPath)
  if (hasFlag("--json")) {
    printBlock(renderPendingLogJson(row, logPath, lines, message, cleanedLogError(tail)))
    if (pendingLogExitCode(row) !== 0) process.exit(pendingLogExitCode(row))
    return true
  }
  printPendingLog(row, host, logPath, lines, message)
  return true
}

const ensureBoxLogArgs = (): void => {
  if (hasFlag("--json") && hasFlag("--follow")) {
    logger.info("[box] --json and --follow are mutually exclusive")
    process.exit(2)
  }
}

const ensureSshReadyBox = (row: BoxRuntimeRow): void => {
  if (row.state !== "running" || row.ip === "" || row.ip === "None") {
    logger.info(
      `[box] ${row.iid} is not ssh-ready yet (state=${row.state}, ip=${row.ip || "none"})`,
    )
    process.exit(1)
  }
}

const printBoxTail = (
  row: BoxRuntimeRow,
  host: string,
  logPath: string,
  lines: number,
  tail: { code: number; out: string; err: string },
): void => {
  if (hasFlag("--json")) {
    printBlock(renderBoxLogsJson(row, logPath, lines, tail))
    if (tail.code !== 0) process.exit(tail.code)
    return
  }
  printBlock(
    [renderBoxLogHeader(row, host, logPath, false), `--- tail -n ${lines} ---`, tail.out.trimEnd()]
      .filter((line) => line !== undefined)
      .join("\n"),
  )
  if (tail.code !== 0) process.exit(tail.code)
}

const renderBoxLogsJson = (
  row: BoxRuntimeRow,
  logPath: string,
  lines: number,
  tail: { code: number; out: string; err: string },
): string =>
  JSON.stringify(
    {
      iid: row.iid,
      ip: row.ip,
      lifecycle: row.lifecycle,
      freshness: row.freshness,
      statusSource: row.statusSource,
      snapshotHealthy: row.snapshotHealthy,
      snapshotState: row.snapshotState,
      phase: row.snapshot?.phase,
      logPath,
      lines,
      snapshot: row.snapshot,
      probe: row.probe,
      ...(hasLaunchTags(row)
        ? {
            launchTags: {
              ...(row.launchMode !== undefined ? { mode: row.launchMode } : {}),
              ...(row.launchPreset !== undefined ? { preset: row.launchPreset } : {}),
              ...(row.launchModel !== undefined ? { model: row.launchModel } : {}),
              ...(row.launchDataset !== undefined ? { dataset: row.launchDataset } : {}),
              ...(row.launchSelection !== undefined ? { selection: row.launchSelection } : {}),
            },
          }
        : {}),
      snapshotAgeSec: row.snapshotAgeSec,
      runAgeSec: row.runAgeSec,
      logAgeSec: row.logAgeSec,
      followHint: row.followHint,
      tail: tail.out,
      error: cleanedLogError(tail),
      exitCode: tail.code,
    },
    null,
    2,
  )

const sshBoxText = async (
  keyPath: string,
  host: string,
  remoteCmd: string,
): Promise<{ code: number; out: string; err: string }> => {
  const proc = Bun.spawn(
    [
      "ssh",
      "-i",
      keyPath,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=20",
      "-o",
      "TCPKeepAlive=yes",
      host,
      remoteCmd,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out, err }
}

const sshBoxFollow = async (keyPath: string, host: string, remoteCmd: string): Promise<number> => {
  const proc = Bun.spawn(
    [
      "ssh",
      "-i",
      keyPath,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=20",
      "-o",
      "TCPKeepAlive=yes",
      host,
      remoteCmd,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  return await proc.exited
}

const cmdBoxLs = async (region: string): Promise<void> => {
  const keyPath = argValue("--key") ?? D.keyPath
  const rows = await listBenchBoxes(region, keyPath)
  if (rows.length === 0) {
    printBlock("[box] no running quanta-bench boxes")
    return
  }
  if (hasFlag("--json")) {
    printBlock(JSON.stringify(rows, null, 2))
    return
  }
  printBlock(renderBoxList(rows))
}

const cmdBoxStatus = async (region: string): Promise<void> => {
  const keyPath = argValue("--key") ?? D.keyPath
  const rows = await listBenchBoxes(region, keyPath)
  const budgetState = await (async (): Promise<{
    budget?: PatchGenBudgetState
    budgetError?: string
  }> => {
    try {
      return { budget: await readPatchGenBudgetState() }
    } catch (err) {
      return { budgetError: `patch-gen budget read failed: ${errMessage(err)}` }
    }
  })()
  const ordered = latestLaunchFirst(rows)
  const summary = summarizeBenchBoxes(ordered)
  if (hasFlag("--json")) {
    printBlock(
      JSON.stringify(
        {
          summary,
          ...(budgetState.budget !== undefined ? { budget: budgetState.budget } : {}),
          ...(budgetState.budgetError !== undefined
            ? { budgetError: budgetState.budgetError }
            : {}),
          boxes: ordered,
        },
        null,
        2,
      ),
    )
    return
  }
  printBlock(renderBoxStatus(summary, ordered, budgetState.budget, budgetState.budgetError))
}

const cmdBoxLogs = async (region: string): Promise<void> => {
  ensureBoxLogArgs()
  const keyPath = argValue("--key") ?? D.keyPath
  const rows = await listBenchBoxes(region, keyPath)
  const row = resolveBoxTarget(rows, positionals()[1])
  const lines = Math.max(1, Math.trunc(Number(argValue("--lines")) || 80))
  if (pendingBootstrappingLog(row)) {
    const host = pendingBootstrappingHost(row)
    printPendingLog(row, host, undefined, lines, pendingLogMessage(row, undefined))
    return
  }
  ensureSshReadyBox(row)
  const logPath = row.logPath ?? DEFAULT_BOX_LOG_PATH
  const host = `ubuntu@${row.ip}`
  if (hasFlag("--follow")) {
    printBlock(renderBoxLogHeader(row, host, logPath, true))
    const code = await sshBoxFollow(keyPath, host, boxTailCommand(logPath, lines, true))
    if (code !== 0) process.exit(code)
    return
  }
  const tail = await sshBoxText(keyPath, host, boxTailCommand(logPath, lines))
  if (handleMissingLogTail(row, host, logPath, lines, tail)) return
  printBoxTail(row, host, logPath, lines, tail)
}

const cmdBoxRm = async (region: string): Promise<void> => {
  const target = positionals()[1]
  if (target === undefined) {
    logger.info("usage: quanta-bench box rm <instance-id|all>")
    process.exit(2)
  }
  let ids: string[]
  if (target === "all") {
    const r = await awsText(region, [
      "ec2",
      "describe-instances",
      ...BOX_TAG_FILTERS,
      "--query",
      "Reservations[].Instances[].InstanceId",
      "--output",
      "text",
    ])
    ids = r.out
      .trim()
      .split(/\s+/)
      .filter((s) => s.startsWith("i-"))
    // BLAST-RADIUS GUARD: EVERY bench box (pool, `grade --mode full`, `box up`)
    // carries the SAME `quanta-bench-full` tag — there is no per-run owner tag —
    // so `rm all` terminates boxes a CONCURRENT run/sweep may be actively grading
    // on (the EC2 form of the "광역 pkill kills the user's bench" hazard). Require
    // an explicit `--yes` and show exactly what will die first.
    if (!hasFlag("--yes")) {
      printBlock(
        [
          `[box] rm all would terminate ${ids.length} box(es) — region-wide, ALL quanta-bench boxes:`,
          ...ids.map((id) => `  ${id}`),
          "⚠️  this kills ANY concurrent run/sweep grading on these boxes. Re-run with --yes to confirm,",
          "    or terminate specific ids: `box rm <i-...>`. Check `box ls` first.",
        ].join("\n"),
      )
      process.exit(2)
    }
  } else {
    ids = [target]
  }
  if (ids.length === 0) {
    logger.info("[box] nothing to terminate")
    return
  }
  const r = await awsText(region, ["ec2", "terminate-instances", "--instance-ids", ...ids])
  logger.info(
    r.code === 0
      ? `[box] terminating: ${ids.join(", ")}`
      : `[box] terminate failed: ${r.err.trim()}`,
  )
  if (r.code !== 0) process.exit(1)
}

const cmdBoxUp = async (): Promise<void> => {
  const amiOverride = argValue("--ami") ?? process.env.QUANTA_FULL_REMOTE_AMI
  logger.info("[box] provisioning + bootstrapping ONE warm box (left alive for reuse)…")
  const session = await provisionBox({
    repoDir: process.cwd(),
    authJson: "{}", // no patch-gen here; pool ships the real token per chunk
    datasetPath: "",
    launchMode: "warm-box",
    ...(amiOverride !== undefined && amiOverride !== "" ? { ami: amiOverride } : {}),
    onDemand: gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND"),
    keep: true, // leave it alive — that is the whole point of `box up`
    onLog: (m) => logger.info(m),
  })
  logger.info(
    `[box] WARM box ready: ${session.iid} (${session.ip}) — pool will reuse it. TTL self-terminates.`,
  )
}

const cmdBox = async (): Promise<void> => {
  const region = argValue("--region") ?? process.env.QUANTA_FULL_REMOTE_REGION ?? D.region
  const action = positionals()[0] ?? "ls"
  if (action === "ls") return cmdBoxLs(region)
  if (action === "status") return cmdBoxStatus(region)
  if (action === "logs") return cmdBoxLogs(region)
  if (action === "rm") return cmdBoxRm(region)
  if (action === "up") return cmdBoxUp()
  logger.info(
    "usage: quanta-bench box <ls [--json]|status [--json]|logs [iid|busy|latest] [--lines N] [--follow|--json]|rm <iid|all>|up>",
  )
  process.exit(2)
}

const cmdGrade = async (): Promise<void> => {
  if ((argValue("--mode") ?? "grade-only") === "full") return cmdGradeFullRemote()

  const predictions = argValue("--predictions")
  const backendSpec = argValue("--backend")
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  if (predictions === undefined || backendSpec === undefined || dataset === undefined) {
    logger.info(
      "usage: quanta-bench grade --predictions <p.jsonl> --backend <ec2|ssh:user@host> --dataset <instances.jsonl> [--max-workers N] [--run-id id] [--key path] [--keep] [--skip-resolved <prior-report.json>]",
    )
    process.exit(2)
  }
  // Incremental grading: `--skip-resolved <prior-report.json>` drops predictions
  // whose instance is already resolved in a prior swebench report, grades only
  // the remainder, then merges the prior resolved set into the final tally. After
  // a few fixes you re-grade ONLY the not-yet-resolved instances — most of the
  // wall-clock (image pull + tests) is spent solely on what can still change.
  let gradePredictions = predictions
  let priorResolved: string[] = []
  const skipReport = argValue("--skip-resolved")
  if (skipReport !== undefined) {
    const rep = JSON.parse(readFileSync(skipReport, "utf8")) as { resolved_ids?: unknown }
    // FILTER to non-empty strings (and accept the double-encoded-JSON-string form
    // some swebench exports emit) — same robustness as analyze/verdicts.ts strArray.
    // The prior `as string[]` cast shipped numbers/nulls straight into `done` and
    // into the merged tally, polluting the resolved count when fed a malformed report.
    priorResolved = resolvedIdsFromReport(rep.resolved_ids)
    const done = new Set(priorResolved)
    const rows = readFileSync(predictions, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
    const remaining = rows.filter((l) => {
      try {
        return !done.has((JSON.parse(l) as { instance_id?: string }).instance_id ?? "")
      } catch {
        return true
      }
    })
    gradePredictions = join(tmpdir(), `quanta-preds-incr-${Date.now()}.jsonl`)
    writeFileSync(gradePredictions, `${remaining.join("\n")}\n`)
    logger.info(
      `incremental: ${priorResolved.length} already-resolved skipped, grading ${remaining.length}/${rows.length}`,
    )
  }

  const runId = argValue("--run-id") ?? `quanta-cli-${Date.now()}`
  const backend = buildBackend(backendSpec, modelNameFromPredictions(gradePredictions))
  logger.info(`grading via ${backend.name}: ${gradePredictions} (run_id=${runId})`)
  const outDir = argValue("--out")
  const out = await backend.grade(gradePredictions, {
    datasetPath: dataset,
    runId,
    ...(outDir !== undefined ? { outDir } : {}),
  })
  const mergedResolved = [...new Set([...priorResolved, ...out.resolved])].sort()
  if (priorResolved.length > 0) {
    logger.info(
      `merged with prior: resolved ${mergedResolved.length} (= ${priorResolved.length} prior + ${out.resolved.length} new)`,
    )
  }
  logger.info(
    `resolved ${out.resolved.length} | unresolved ${out.unresolved.length} | error ${out.errored.length} | empty ${out.emptyPatch.length}`,
  )
  for (const id of out.resolved) logger.info(`  ✅ ${id}`)
  for (const id of out.unresolved) logger.info(`  ❌ ${id}`)
  for (const id of out.errored) logger.info(`  ⚠️  ${id}`)
  for (const id of out.emptyPatch) logger.info(`  ∅ ${id}`)
  logger.info(`report: ${out.reportPath}`)
}

const cmdDiff = (): void => {
  const [a, b] = positionals()
  if (a === undefined || b === undefined) {
    logger.info("usage: quanta-bench diff <reportA.json> <reportB.json>")
    process.exit(2)
  }
  printBlock(renderDiff(diffRuns(loadVerdictsFromFile(a), loadVerdictsFromFile(b))))
}

const cmdExplain = (): void => {
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  const instance = argValue("--instance")
  if (dataset === undefined || instance === undefined) {
    logger.info(
      "usage: quanta-bench explain --dataset <instances.jsonl> --instance <id> [--patch <agent.patch>]",
    )
    process.exit(2)
  }
  const patch = argValue("--patch")
  const e = explainFailure({
    datasetPath: dataset,
    instanceId: instance,
    ...(patch !== undefined ? { agentPatchPath: patch } : {}),
  })
  printBlock(e.summary)
}

const cmdLeaderboard = (): void => {
  const reports = positionals()
  if (reports.length === 0) {
    logger.info(
      "usage: quanta-bench leaderboard <report.json> [more.json …] [--preset name] [--title T]",
    )
    process.exit(2)
  }
  // Profile is AUTO-DETECTED per report from `report.knobs.preset` (each run
  // records the preset it ran under), so combining reports from different
  // profiles labels each instance with the preset it was ACTUALLY resolved
  // under — never a single blanket label. `--preset` is an explicit override.
  const presetOverride = argValue("--preset")
  const rows = reports.flatMap((p) => {
    const v = loadVerdictsFromFile(p)
    const meta = (() => {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as {
          model?: string
          knobs?: { preset?: string }
        }
      } catch {
        return {} as { model?: string; knobs?: { preset?: string } }
      }
    })()
    const model = meta.model ?? "unknown"
    const preset = presetOverride ?? meta.knobs?.preset ?? "unknown"
    return rowsFromRun(v, { preset, model })
  })
  printBlock(renderLeaderboardMarkdown(rows, argValue("--title") ?? "SWE-bench leaderboard"))
}

const cmdCost = (): void => {
  const [report] = positionals()
  if (report === undefined) {
    logger.info("usage: quanta-bench cost <report.json> [--observe-dir <dir>]")
    process.exit(2)
  }
  const observeDir = argValue("--observe-dir")
  printBlock(
    renderCost(
      costSummaryFromReport({
        reportPath: report,
        ...(observeDir !== undefined ? { observeDir } : {}),
      }),
    ),
  )
}

const cmdPresets = (): void => {
  for (const line of renderBenchPresetListLines()) logger.info(line)
}

const HELP = `quanta-bench — unified SWE-bench CLI (ADR-0536)

  run          local patch-gen + optional local grading (legacy flat flags)
  grade        grade existing predictions on a remote backend (ec2 | ssh:host)
  diff         compare two run reports (A/B, regression)
  explain      agent-vs-gold failure analysis for one instance
  leaderboard  render an official/local/research split table from run report(s)
  cost         token / $ / wall-clock summary for a run report
  presets      list bench presets

Default live execution preset: ${CURRENT_BENCH_BASE_PRESET}
Explicit selectors still win: QUANTA_BENCH_PRESET > QUANTA_BENCH_SOTA > QUANTA_KNOBS_PRESET > --preset.

Run a subcommand with no/invalid args to see its usage. No subcommand ⇒ 'run'.`

const main = async (): Promise<void> => {
  const sub = process.argv[2]
  // Legacy: no subcommand, or a leading flag ⇒ route to `run` (byte-compat with
  // the historical `index.ts --swebench …` entry).
  if (sub === undefined || sub.startsWith("-") || !KNOWN_SUBCOMMANDS.has(sub)) {
    if (sub === "help" || sub === "--help" || sub === "-h") {
      printBlock(HELP)
      return
    }
    const { runMain } = await import("./index")
    await runMain()
    return
  }
  switch (sub) {
    case "run": {
      const { runMain } = await import("./index")
      await runMain()
      return
    }
    case "grade":
    case "remote":
      await cmdGrade()
      return
    case "pool":
      await cmdPool()
      return
    case "box":
      await cmdBox()
      return
    case "auth":
      await cmdAuth()
      return
    case "diff":
      cmdDiff()
      return
    case "explain":
      cmdExplain()
      return
    case "leaderboard":
      cmdLeaderboard()
      return
    case "cost":
      cmdCost()
      return
    case "presets":
      cmdPresets()
      return
    default:
      printBlock(HELP)
  }
}

// Only run when invoked directly (not when imported by a test) so unit tests
// can exercise the helpers without launching the CLI.
if (import.meta.main) {
  main().catch((err) => {
    logger.info(`quanta-bench error: ${errMessage(err)}`)
    process.exit(1)
  })
}

// Exported for unit tests (pure CLI-arg helpers — the routing-bug surface).
export { argValue, buildBackend, modelNameFromPredictions, positionals }
// Note: `parseMaxWorkers` and `resolvedIdsFromReport` are exported at their
// definitions above (pure validators/coercers — unit-tested directly).
