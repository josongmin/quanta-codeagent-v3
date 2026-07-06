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
import { resolve } from "node:path"
import type { LLMPort } from "@/llm"
import type { MatchPolicy } from "@/llm/replay"
import { jsonlReplayStore, type OnMissPolicy, recordingLlmPort, replayLlmPort } from "@/llm/replay"
import type { StreamInput } from "@/llm/types"
import { isFalsyToken } from "@/shared"
import { resumeHashRequest } from "./resume/canonicalize"
import { resolveResumeConfig, resumeActive } from "./resume/config"
import { maybeTeeResumeRecording } from "./resume/recorder"

const defaultBenchTrajectoryPath = (): string => `${process.cwd()}/bench-trajectory.jsonl`

const trajectoryPathFromRaw = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "" || raw === "0") return undefined
  return raw === "1" || raw.toLowerCase() === "on" ? defaultBenchTrajectoryPath() : raw
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
 *   - unset / "" / "1" / "on" / unrecognized ⇒ default `<cwd>/bench-trajectory.jsonl`
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
 * (byte-identical). "1" | "on" ⇒ record to `<cwd>/bench-trajectory.jsonl`. Any
 * other value ⇒ treated as the cassette path.
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
  return recordingLlmPort({ inner: llm, store: jsonlReplayStore({ path: mode.path }) })
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

export const applyBenchTrajectoryMode = (
  llm: LLMPort,
  mode: BenchTrajectoryMode,
  identity: { provider: string; model: string },
  ctx?: { instanceId?: string; runId?: string; attempt?: number },
): LLMPort => {
  if (mode.kind === "off") return llm
  if (mode.kind === "record")
    return recordingLlmPort({
      inner: llm,
      store: jsonlReplayStore({ path: mode.path }),
      ...(ctx !== undefined ? { callCtx: ctx } : {}),
    })
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
