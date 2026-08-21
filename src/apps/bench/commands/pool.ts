/**
 * `quanta-bench pool` — persistent-pool full-remote (jun-20 box-lifecycle
 * Phase 2/3), extracted from cli.ts (ADR-0536 P0). Bootstraps boxes ONCE and
 * feeds them a queue of dataset chunks. Moved verbatim; behaviour-identical.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gateOn, logger } from "@/shared"
import {
  AuthLeaseManager,
  type AuthSource,
  describeAuthSource,
  resolveAuthLaunchFile,
} from "../auth-pool"
import { bridgeDatasetFamilyToEnv } from "../dataset-family"
import { resolveRemoteBenchExecutionPreset } from "../preset"
import { refreshRemoteAuthJson } from "../remote/fresh-auth"
import { buildForwardedBenchEnv } from "../remote/full"
import { type PoolChunk, runPool } from "../remote/pool"
import { createLeasePoolAuthProvider, type PoolAuthProvider } from "../remote/pool-auth"
import { clampPatchGenConcurrency, resolveGlobalPatchGenBudget } from "../remote/token-budget"
import {
  defaultMicrochunkDir,
  type Microchunk,
  planMicrochunks,
  writeMicrochunks,
} from "../slicing/microchunk"
import {
  allowExtraBoxes,
  argValue,
  hasFlag,
  positiveMinutesFlagMs,
  printBlock,
  resolveCliAuthSource,
  waitForIdleBox,
} from "./shared"

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

export const cmdPool = async (): Promise<void> => {
  // Pool preflight, provisioning, and every on-box chunk read this env selector.
  bridgeDatasetFamilyToEnv(argValue("--dataset-family"), process.env)
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
  const preset = resolveRemoteBenchExecutionPreset({
    family: process.env.QUANTA_SWEBENCH_DATASET_FAMILY ?? "verified",
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

type PoolRunResult = Awaited<ReturnType<typeof runPool>>[number]

const summarizePoolChunk = (
  result: PoolRunResult,
): {
  readonly resolved: number
  readonly lost: number
  readonly partial: number
  lines: string[]
} => {
  const resolved = result.result.resolved?.length ?? 0
  const missing = result.missing?.length ?? 0
  const lost = result.lost ? 1 : 0
  const partial = !result.lost && missing > 0 ? 1 : 0
  let tag = "ok"
  if (result.lost) tag = "❓ LOST"
  else if (missing > 0) tag = "⚠️ PARTIAL"
  return {
    resolved,
    lost,
    partial,
    lines: [
      `[pool] chunk ${result.chunk.runId}: ${tag} — resolved ${resolved} | unresolved ${result.result.unresolved?.length ?? 0} | missing ${missing} | attempts ${result.attempts}`,
      ...(result.missing ?? []).map((id) => `[pool]   ❓ MISSING ${id}`),
    ],
  }
}

export const summarizePoolRunLines = (
  out: Awaited<ReturnType<typeof runPool>>,
  chunkCount: number,
): string[] => {
  let resolved = 0
  let lost = 0
  let partial = 0
  const lines: string[] = []
  for (const result of out) {
    const summary = summarizePoolChunk(result)
    resolved += summary.resolved
    lost += summary.lost
    partial += summary.partial
    lines.push(...summary.lines)
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
