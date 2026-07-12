/**
 * Bench-native LLM-trajectory record/replay (RFC §8 / ADR fork-from-bench).
 *
 * Extracted verbatim from `index.ts` as a self-contained cluster: every bench
 * LLM consumer takes the port `resolveLLM` returns, so wrapping the port here
 * records/replays the ENTIRE run. Default-OFF and byte-identical when the
 * `QUANTA_BENCH_RECORD_TRAJECTORY` / `QUANTA_BENCH_REPLAY_TRAJECTORY` gates are
 * unset.
 *
 * WHY (record): when a bench instance FAILS, we want to replay its exact LLM
 * trajectory deterministically up to any turn and DIVERGE there — the
 * bench-native "fork from a point" for cheaply testing a localization/strategy
 * fix on a recorded failure WITHOUT re-running the whole expensive run. The CLI
 * `fork_session` feature is REPL-scoped (ConversationCheckpointStore) and CANNOT
 * reach a bench trajectory, so this is the only path that makes bench
 * replay/fork possible.
 *
 * STRICT by default (replay): `QUANTA_BENCH_REPLAY_ON_MISS` defaults to `throw`,
 * so a stale or short cassette fails LOUDLY instead of silently drifting onto
 * live model output. Operators who intentionally want "replay until the fork
 * point, then diverge live" opt into `record-and-passthrough`.
 */
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { LLMPort } from "@/llm"
import type { MatchPolicy } from "@/llm/replay"
import { jsonlReplayStore, type OnMissPolicy, recordingLlmPort, replayLlmPort } from "@/llm/replay"
import type { StreamInput } from "@/llm/types"
import { getActiveTraceRef } from "@/observability"
import { benchHome, benchRunId } from "@/runner/batch/corpus/paths"
import { isFalsyToken } from "@/shared"
import { resumeHashRequest } from "./resume/canonicalize"
import { resolveResumeConfig, resumeActive } from "./resume/config"
import { maybeTeeResumeRecording } from "./resume/recorder"
import { debugSink, isTrajectoryDebugEnabled } from "./trajectory-debug-sink"

/**
 * jul-9 — UNIFY the default trajectory sink under the persistent bench-home run dir
 * (`<benchHome>/runs/<runId>/trajectory.jsonl`, i.e. `~/Library/quanta-codeagent-v3/bench/
 * runs/<runId>/…` on macOS) — the SAME `runs/<runId>/` grouping observe/predictions/report
 * already use, so a run's whole artifact set co-locates under one session dir instead of a
 * single `<cwd>/bench-trajectory.jsonl` that clobbered across runs and littered the repo.
 * `QUANTA_RUN_ID` pins the runId (co-locating with observe); unset ⇒ a `run-<ts>` dir, still
 * under bench-home. PURE (no mkdir) — the jsonl store creates the parent on write. An
 * explicit `QUANTA_BENCH_RECORD_TRAJECTORY=<path>` still wins verbatim (override unchanged).
 */
const defaultBenchTrajectoryPath = (): string =>
  join(benchHome(), "runs", benchRunId(), "trajectory.jsonl")

const trajectoryPathFromRaw = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "" || raw === "0") return undefined
  // `debug` is the enrichment-TIER token (see isTrajectoryDebugEnabled), NOT a
  // path — resolve it to the default cassette like "1"/"on" so the tier and the
  // path stay orthogonal (RECORD=debug records to the default file AND enriches,
  // instead of writing to a stray file literally named "debug").
  const low = raw.toLowerCase()
  return raw === "1" || low === "on" || low === "debug" ? defaultBenchTrajectoryPath() : raw
}

/**
 * BENCH default for LLM-trajectory RECORDING: DEFAULT-ON (industry-SOTA —
 * SWE-agent / mini-swe / LangSmith all persist the full agent conversation by
 * default; recording is opt-OUT, not opt-in). A CODE default (mirrors
 * `./reasoning-summary`) so it rides the rsynced bench source to the full-remote
 * box with NO env forwarding.
 *
 * Resolution of `QUANTA_BENCH_RECORD_TRAJECTORY` → the record path (or
 * `undefined` = no recording):
 *   - unset / "" / "1" / "on" / unrecognized ⇒ unified default `<benchHome>/runs/<runId>/trajectory.jsonl`
 *   - "0" / off / false / no                 ⇒ undefined (operator opt-OUT)
 *   - any other string                       ⇒ treated as the cassette path
 *
 * `explicit` is true iff the operator set a recognized value (a path, "1"/"on",
 * or a falsy opt-out token). It is FALSE for unset / "" / unrecognized. The
 * caller uses it so the record⇄replay mutual-exclusion check ONLY fires when the
 * operator EXPLICITLY asked to record alongside replay — the default-on path
 * must never spuriously collide with an explicit replay request.
 */
export const resolveBenchTrajectoryDefault = (
  env: Record<string, string | undefined>,
): { path: string | undefined; explicit: boolean } => {
  const raw = env.QUANTA_BENCH_RECORD_TRAJECTORY
  if (isFalsyToken(raw)) return { path: undefined, explicit: true } // operator opt-OUT
  const fromRaw = trajectoryPathFromRaw(raw) // path | "1"/"on"→default | undefined(unset/"")
  return { path: fromRaw ?? defaultBenchTrajectoryPath(), explicit: fromRaw !== undefined }
}

const replayOnMissFromRaw = (raw: string | undefined): OnMissPolicy => {
  if (raw === undefined || raw === "") return "throw"
  if (raw === "throw" || raw === "passthrough" || raw === "record-and-passthrough") return raw
  throw new Error(
    `invalid QUANTA_BENCH_REPLAY_ON_MISS=${JSON.stringify(raw)} — expected throw | passthrough | record-and-passthrough`,
  )
}

/** Parse `QUANTA_BENCH_REPLAY_LIMIT` — a non-negative integer cap on how many
 *  recorded interactions are eligible to replay (fork-at-N without a mutator).
 *  Absent/"" ⇒ undefined (whole cassette). Invalid (non-int / negative) THROWS
 *  loudly so an operator/agent sees the typo instead of a silently-ignored cap. */
const replayLimitFromRaw = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `invalid QUANTA_BENCH_REPLAY_LIMIT=${JSON.stringify(raw)} — expected a non-negative integer`,
    )
  }
  return n
}

export type BenchTrajectoryMode =
  | { kind: "off" }
  | { kind: "record"; path: string }
  | { kind: "replay"; path: string; onMiss: OnMissPolicy; limit?: number }

export const resolveBenchTrajectoryMode = (): BenchTrajectoryMode => {
  // Record is DEFAULT-ON for bench (industry-SOTA opt-OUT). `recordExplicit`
  // gates the collision check so the default-on path never spuriously trips the
  // mutual-exclusion throw against an explicit replay request.
  const { path: recordPath, explicit: recordExplicit } = resolveBenchTrajectoryDefault(process.env)
  const replayPath = trajectoryPathFromRaw(process.env.QUANTA_BENCH_REPLAY_TRAJECTORY)
  if (recordExplicit && recordPath !== undefined && replayPath !== undefined) {
    throw new Error(
      "cannot combine QUANTA_BENCH_RECORD_TRAJECTORY with QUANTA_BENCH_REPLAY_TRAJECTORY",
    )
  }
  if (replayPath !== undefined) {
    const limit = replayLimitFromRaw(process.env.QUANTA_BENCH_REPLAY_LIMIT)
    return {
      kind: "replay",
      path: replayPath,
      onMiss: replayOnMissFromRaw(process.env.QUANTA_BENCH_REPLAY_ON_MISS),
      ...(limit !== undefined ? { limit } : {}),
    }
  }
  if (recordPath !== undefined) return { kind: "record", path: recordPath }
  return { kind: "off" }
}

export const replayTrajectoryPort = (args: {
  path: string
  onMiss: OnMissPolicy
  limit?: number
  fallback?: LLMPort
  provider?: string
  model?: string
  /**
   * Override the request→hash the jsonl replay store uses to match. The resume
   * path threads the CANONICALIZING `resumeHashRequest` here so a cassette
   * recorded on box A replays HIT on box B despite volatile tool-output tokens.
   * Absent ⇒ `defaultHashRequest` (byte-identical to the prior default path).
   */
  hashRequest?: (req: StreamInput, policy: MatchPolicy) => string
}): LLMPort => {
  if (args.onMiss !== "throw" && args.fallback === undefined) {
    throw new Error(`QUANTA_BENCH_REPLAY_ON_MISS=${args.onMiss} requires a live fallback LLMPort`)
  }
  return replayLlmPort({
    store: jsonlReplayStore({
      path: args.path,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.hashRequest !== undefined ? { hashRequest: args.hashRequest } : {}),
    }),
    onMiss: args.onMiss,
    ...(args.fallback !== undefined ? { fallback: args.fallback } : {}),
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.fallback?.surfaceId !== undefined ? { surfaceId: args.fallback.surfaceId } : {}),
    ...(args.fallback?.transportId !== undefined ? { transportId: args.fallback.transportId } : {}),
    ...(args.fallback?.authMode !== undefined ? { authMode: args.fallback.authMode } : {}),
  })
}

/**
 * Optional LLM-trajectory recording for bench runs (default-OFF).
 *
 * Single chokepoint: every bench LLM consumer (driver, localize, repro,
 * verify-guard …) takes the port `resolveLLM` returns, so wrapping here records
 * the ENTIRE run.
 *
 * Gate: `QUANTA_BENCH_RECORD_TRAJECTORY`. Absent / "" / "0" ⇒ NO wrap
 * (byte-identical). "1" | "on" ⇒ record to the unified default
 * `<benchHome>/runs/<runId>/trajectory.jsonl`. Any other value ⇒ the cassette path.
 */
export const maybeRecordTrajectory = (llm: LLMPort): LLMPort => {
  const mode = resolveBenchTrajectoryMode()
  if (mode.kind !== "record") return llm
  // Resume WRITE path (DEFAULT-OFF, fail-closed): when `QUANTA_BENCH_RESUME` is
  // active AND `QUANTA_BENCH_INSTANCE_ID` is set, mirror the SAME local cassette
  // (`mode.path`) to durable S3 + maintain a receipt. Otherwise this returns the
  // inner `llm` UNCHANGED, and we fall through to the EXACT prior behavior
  // (plain local-only jsonl recording) — byte-identical when resume is off.
  const teed = maybeTeeResumeRecording(llm, process.env, mode.path)
  if (teed !== llm) return teed
  return recordingLlmPort({
    inner: llm,
    store: jsonlReplayStore({ path: mode.path }),
    // C4 (jul-12 OTel unification): supply the active-span provider so each
    // recorded turn carries the enclosing `chat` span's `{traceId,spanId}` and
    // joins the OTLP/OBSERVE trace tree. DI (not an `@/observability` import in
    // `@/llm/replay`, which is slice-forbidden); `@/apps/bench` may reach it.
    // Metadata-only ⇒ REPLAY-NEUTRAL; absent active span ⇒ byte-identical.
    getActiveTraceRef,
    ...(isTrajectoryDebugEnabled() ? { debugDrain: () => debugSink.drain() } : {}),
  })
}

/**
 * Optional bench-native trajectory replay (default-OFF).
 *
 * STRICT by default: `QUANTA_BENCH_REPLAY_TRAJECTORY` replays from a cassette and
 * `QUANTA_BENCH_REPLAY_ON_MISS` defaults to `throw`, so a stale or short cassette
 * fails LOUDLY instead of silently drifting onto live model output. Operators who
 * intentionally want "replay until the fork point, then diverge live" opt into
 * `record-and-passthrough`.
 */
export const maybeReplayTrajectory = (llm: LLMPort): LLMPort => {
  const mode = resolveBenchTrajectoryMode()
  if (mode.kind !== "replay") return llm
  // RESUME-GATED canonicalization: only when `resumeActive` (gate ON + bucket)
  // do we mask volatile tokens before matching, so cross-box replay HITs. The
  // DEFAULT (resume off) path omits `hashRequest` ⇒ `defaultHashRequest`,
  // byte-identical to the prior behavior.
  const resumeOn = resumeActive(resolveResumeConfig(process.env))
  return replayTrajectoryPort({
    path: mode.path,
    onMiss: mode.onMiss,
    ...(mode.onMiss === "throw" ? {} : { fallback: llm }),
    ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
    ...(llm.model !== undefined ? { model: llm.model } : {}),
    ...(resumeOn ? { hashRequest: resumeHashRequest } : {}),
  })
}

const fmtTs = (d: Date): string => {
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * When instanceId is known, record to
 * `<dir>/trajectories/<YYYYMMDD-HHmmss>-<instanceId>.jsonl` so each run of
 * the same problem gets its own file (timestamp prefix prevents overwrite).
 * Returns both the jsonl path and the companion meta path.
 */
const resolveRecordPaths = (
  basePath: string,
  instanceId: string | undefined,
  attempt?: number,
): { jsonl: string; meta: string | undefined } => {
  if (!instanceId) return { jsonl: basePath, meta: undefined }
  const safe = instanceId.replace(/[^A-Za-z0-9._-]/g, "_")
  const ts = fmtTs(new Date())
  const sfx = attempt !== undefined ? `-a${attempt}` : ""
  const base = `${dirname(basePath)}/trajectories/${ts}-${safe}${sfx}`
  return { jsonl: `${base}.jsonl`, meta: `${base}.meta.json` }
}

/** Collect all QUANTA_* env vars + argv into a run meta snapshot. */
const buildRunMeta = (
  identity: { provider: string; model: string },
  ctx: { instanceId?: string; runId?: string; attempt?: number } | undefined,
): Record<string, unknown> => {
  const quantaEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("QUANTA_") && v !== undefined) quantaEnv[k] = v
  }
  return {
    recordedAt: new Date().toISOString(),
    instanceId: ctx?.instanceId,
    runId: ctx?.runId,
    attempt: ctx?.attempt,
    provider: identity.provider,
    model: identity.model,
    argv: process.argv.slice(2),
    env: quantaEnv,
    // runContext enricher: flag the debug tier so the viewer can badge a
    // cassette as debug-enriched and expect `metadata.debug` per turn.
    debug: isTrajectoryDebugEnabled(),
  }
}

/** Process-scoped registry: instanceId → last-written meta file path.
 *  Populated in `applyBenchTrajectoryMode` so post-run callers can patch the
 *  meta with verdict/editTrace data without re-deriving the timestamped path. */
const metaPathRegistry = new Map<string, string>()

export const applyBenchTrajectoryMode = (
  llm: LLMPort,
  mode: BenchTrajectoryMode,
  identity: { provider: string; model: string },
  ctx?: { instanceId?: string; runId?: string; attempt?: number },
): LLMPort => {
  if (mode.kind === "off") return llm
  if (mode.kind === "record") {
    const { jsonl: path, meta: metaPath } = resolveRecordPaths(
      mode.path,
      ctx?.instanceId,
      ctx?.attempt,
    )
    if (metaPath !== undefined) {
      if (ctx?.instanceId !== undefined) metaPathRegistry.set(ctx.instanceId, metaPath)
      const meta = buildRunMeta(identity, ctx)
      // Fire-and-forget: meta write failure must never crash the bench run.
      writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8").catch(() => {})
    }
    return recordingLlmPort({
      inner: llm,
      store: jsonlReplayStore({ path }),
      ...(ctx !== undefined ? { callCtx: ctx } : {}),
      // C4: active-span provider (same seam as callCtx) so each recorded turn
      // joins the trace tree on `{traceId,spanId}`. Metadata-only, replay-neutral.
      getActiveTraceRef,
      // DEBUG tier: drain per-turn debug slices contributed by other subsystems
      // (metadata-only, replay-neutral). No-op unless the debug gate is on.
      ...(isTrajectoryDebugEnabled() ? { debugDrain: () => debugSink.drain() } : {}),
    })
  }
  return replayTrajectoryPort({
    path: mode.path,
    onMiss: mode.onMiss,
    ...(mode.limit !== undefined ? { limit: mode.limit } : {}),
    ...(mode.onMiss === "throw" ? {} : { fallback: llm }),
    provider: identity.provider,
    model: identity.model,
  })
}

/**
 * Patch the run meta.json for `instanceId` with extra post-run fields (e.g.
 * verdict). No-op when debug gate is off, no meta path is registered, or on
 * any I/O failure. Best-effort: write failures are silently swallowed so they
 * never crash a bench run.
 */
export const patchRunMeta = async (
  instanceId: string,
  extra: Record<string, unknown>,
): Promise<void> => {
  if (!isTrajectoryDebugEnabled()) return
  const metaPath = metaPathRegistry.get(instanceId)
  if (!metaPath) return
  try {
    const existing = JSON.parse(await readFile(metaPath, "utf8"))
    await writeFile(metaPath, JSON.stringify({ ...existing, ...extra }, null, 2), "utf8")
  } catch {
    // best-effort
  }
}

/** Test seam: clear the meta-path registry between test cases. */
export const resetMetaPathRegistry = (): void => {
  metaPathRegistry.clear()
}

/**
 * Produce a TRUNCATED copy of a cassette — the first `keep` recorded
 * interactions only — at `dest`, WITHOUT mutating the source. A shareable file
 * artifact for "replay the prefix, diverge after N" when you want a smaller
 * cassette on disk rather than the in-place {@link replayLimitFromRaw} cap
 * (`QUANTA_BENCH_REPLAY_LIMIT`), which needs no copy. Reuses the store's
 * load/save so the round-trip is byte-faithful (same normalization). `keep <= 0`
 * ⇒ an empty cassette; `keep >= total` ⇒ a full copy. Returns the counts.
 */
export const truncateCassette = async (
  src: string,
  keep: number,
  dest: string,
): Promise<{ dest: string; kept: number; total: number }> => {
  if (resolve(dest) === resolve(src)) {
    // Refuse to overwrite the source — truncation is non-destructive by contract.
    throw new Error(`truncateCassette: dest must differ from src (got ${JSON.stringify(src)})`)
  }
  const all = await jsonlReplayStore({ path: src }).load()
  const kept = all.slice(0, Math.max(0, keep))
  await jsonlReplayStore({ path: dest }).save(kept)
  return { dest, kept: kept.length, total: all.length }
}
