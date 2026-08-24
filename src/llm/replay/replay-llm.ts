/**
 * Replay `LLMPort` adapter (ADR-0192).
 *
 * Replaces a real adapter with one that satisfies `stream()` from a
 * `ReplayStore`. On miss, the caller-supplied `onMiss` policy decides:
 *
 *  - `"throw"`              — strict; throws `ReplayMissError`. CI default.
 *  - `"passthrough"`        — falls back to a real `LLMPort` without writing
 *                              the response back to the store. Useful when
 *                              the cassette is "best-effort cache" and live
 *                              calls are acceptable.
 *  - `"record-and-passthrough"` — falls back AND records the result through
 *                              `recordingLlmPort`. Useful for cassette
 *                              expansion: existing recordings replay; new
 *                              requests transparently extend the cassette.
 *
 * Events are yielded one-by-one from the recorded array so consumers see the
 * same streaming shape they would from a live adapter. Caller cancellation
 * (`input.signal`) is honoured: aborting between events stops yielding.
 */

import { throwIfAborted } from "@/shared"
import type { LlmSurfaceId, LlmTransportId } from "@/shared/llm-route-types"
import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"
import { recordingLlmPort } from "./recording-llm"
import {
  type MatchPolicy,
  type RecordedInteraction,
  ReplayMissError,
  type ReplayStore,
} from "./types"

export type OnMissPolicy = "throw" | "passthrough" | "record-and-passthrough"

export interface ReplayLlmOpts {
  /** Cassette to read from (and, in `record-and-passthrough`, write to). */
  readonly store: ReplayStore
  /** Match policy passed to `store.match`. Defaults to `"exact"`. */
  readonly matchPolicy?: MatchPolicy
  /** What to do when no recording matches. Defaults to `"throw"`. */
  readonly onMiss?: OnMissPolicy
  /** REQUIRED when `onMiss !== "throw"`. The real adapter to call on miss. */
  readonly fallback?: LLMPort
  /** Identity for the synthetic port (mirrors what a real adapter exposes). */
  readonly model?: string
  readonly provider?: string
  readonly surfaceId?: LlmSurfaceId
  readonly transportId?: LlmTransportId
  readonly authMode?: string
}

async function* replayEvents(
  rec: RecordedInteraction,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
  for (const ev of rec.events) {
    if (signal?.aborted === true) {
      // Mirror real-adapter cancellation: throw the signal's reason (or a
      // plain Error if reason is missing) so loop-side cancel detection paths
      // remain symmetric between live and replay.
      const reason: unknown = signal.reason
      throw reason instanceof Error ? reason : new Error("replay aborted")
    }
    yield ev
  }
}

/** Pick the port a cassette MISS falls through to, or raise
 *  {@link ReplayMissError} when this replay port has no fallthrough.
 *
 *  A unit because "what a miss means" is ONE decision with exactly three
 *  outcomes — refuse (`onMiss:"throw"`), fall through to the recording chain
 *  (`record-and-passthrough`), or fall through to the bare fallback — and all
 *  three converge on the same error when no port is actually available. The
 *  final `undefined` check is defensive only: the constructor already rejects a
 *  non-throw policy without a fallback, but TS cannot narrow that across the
 *  closure. Deliberately SYNC (the original inline form was too), so no await
 *  point moves relative to the cassette lookup. */
const resolveMissUpstream = (
  input: StreamInput,
  policy: MatchPolicy,
  onMiss: OnMissPolicy,
  fallback: LLMPort | undefined,
  recordingFallback: LLMPort | null,
): LLMPort => {
  if (onMiss === "throw") throw new ReplayMissError(input, policy)
  const upstream =
    onMiss === "record-and-passthrough" && recordingFallback !== null ? recordingFallback : fallback
  if (upstream === undefined) throw new ReplayMissError(input, policy)
  return upstream
}

export function replayLlmPort(opts: ReplayLlmOpts): LLMPort {
  const policy: MatchPolicy = opts.matchPolicy ?? "exact"
  const onMiss: OnMissPolicy = opts.onMiss ?? "throw"

  if (onMiss !== "throw" && opts.fallback === undefined) {
    throw new Error(`replayLlmPort: onMiss="${onMiss}" requires a fallback LLMPort`)
  }

  // Pre-wire the recording chain so each miss reuses the same scrubber-free
  // recorder rather than allocating per call.
  const fallback = opts.fallback
  const recordingFallback =
    onMiss === "record-and-passthrough" && fallback !== undefined
      ? recordingLlmPort({ inner: fallback, store: opts.store })
      : null

  const port: LLMPort = {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.surfaceId !== undefined ? { surfaceId: opts.surfaceId } : {}),
    ...(opts.transportId !== undefined ? { transportId: opts.transportId } : {}),
    ...(opts.authMode !== undefined ? { authMode: opts.authMode } : {}),
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      async function* run(): AsyncIterable<StreamEvent> {
        const hit = await opts.store.match(input, { policy })
        if (hit !== null) {
          yield* replayEvents(hit, input.signal)
          return
        }
        // passthrough — caller's signal flows through `input` unchanged.
        const upstream = resolveMissUpstream(input, policy, onMiss, fallback, recordingFallback)
        for await (const ev of upstream.stream(input)) {
          // L6 M9: honour caller cancellation between yields so the passthrough
          // path has parity with the replay-hit path (replayEvents already does
          // this). A bare for-await would ignore an abort fired mid-drain.
          throwIfAborted(input.signal)
          yield ev
        }
      }
      return run()
    },
  }
  return port
}
