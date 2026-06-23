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
import type { LLMPort } from "@/llm"
import { jsonlReplayStore, type OnMissPolicy, recordingLlmPort, replayLlmPort } from "@/llm/replay"

const defaultBenchTrajectoryPath = (): string => `${process.cwd()}/bench-trajectory.jsonl`

const trajectoryPathFromRaw = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "" || raw === "0") return undefined
  return raw === "1" || raw.toLowerCase() === "on" ? defaultBenchTrajectoryPath() : raw
}

const replayOnMissFromRaw = (raw: string | undefined): OnMissPolicy => {
  if (raw === undefined || raw === "") return "throw"
  if (raw === "throw" || raw === "passthrough" || raw === "record-and-passthrough") return raw
  throw new Error(
    `invalid QUANTA_BENCH_REPLAY_ON_MISS=${JSON.stringify(raw)} — expected throw | passthrough | record-and-passthrough`,
  )
}

export type BenchTrajectoryMode =
  | { kind: "off" }
  | { kind: "record"; path: string }
  | { kind: "replay"; path: string; onMiss: OnMissPolicy }

export const resolveBenchTrajectoryMode = (): BenchTrajectoryMode => {
  const recordPath = trajectoryPathFromRaw(process.env.QUANTA_BENCH_RECORD_TRAJECTORY)
  const replayPath = trajectoryPathFromRaw(process.env.QUANTA_BENCH_REPLAY_TRAJECTORY)
  if (recordPath !== undefined && replayPath !== undefined) {
    throw new Error(
      "cannot combine QUANTA_BENCH_RECORD_TRAJECTORY with QUANTA_BENCH_REPLAY_TRAJECTORY",
    )
  }
  if (replayPath !== undefined) {
    return {
      kind: "replay",
      path: replayPath,
      onMiss: replayOnMissFromRaw(process.env.QUANTA_BENCH_REPLAY_ON_MISS),
    }
  }
  if (recordPath !== undefined) return { kind: "record", path: recordPath }
  return { kind: "off" }
}

export const replayTrajectoryPort = (args: {
  path: string
  onMiss: OnMissPolicy
  fallback?: LLMPort
  provider?: string
  model?: string
}): LLMPort => {
  if (args.onMiss !== "throw" && args.fallback === undefined) {
    throw new Error(`QUANTA_BENCH_REPLAY_ON_MISS=${args.onMiss} requires a live fallback LLMPort`)
  }
  return replayLlmPort({
    store: jsonlReplayStore({ path: args.path }),
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
  return mode.kind === "record"
    ? recordingLlmPort({ inner: llm, store: jsonlReplayStore({ path: mode.path }) })
    : llm
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
  return replayTrajectoryPort({
    path: mode.path,
    onMiss: mode.onMiss,
    ...(mode.onMiss === "throw" ? {} : { fallback: llm }),
    ...(llm.provider !== undefined ? { provider: llm.provider } : {}),
    ...(llm.model !== undefined ? { model: llm.model } : {}),
  })
}

export const applyBenchTrajectoryMode = (
  llm: LLMPort,
  mode: BenchTrajectoryMode,
  identity: { provider: string; model: string },
): LLMPort => {
  if (mode.kind === "off") return llm
  if (mode.kind === "record")
    return recordingLlmPort({ inner: llm, store: jsonlReplayStore({ path: mode.path }) })
  return replayTrajectoryPort({
    path: mode.path,
    onMiss: mode.onMiss,
    ...(mode.onMiss === "throw" ? {} : { fallback: llm }),
    provider: identity.provider,
    model: identity.model,
  })
}
