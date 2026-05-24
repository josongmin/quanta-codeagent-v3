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
    ...(opts.authMode !== undefined ? { authMode: opts.authMode } : {}),
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      async function* run(): AsyncIterable<StreamEvent> {
        const hit = await opts.store.match(input, { policy })
        if (hit !== null) {
          yield* replayEvents(hit, input.signal)
          return
        }
        if (onMiss === "throw") {
          throw new ReplayMissError(input, policy)
        }
        // passthrough — caller's signal flows through `input` unchanged.
        const upstream =
          onMiss === "record-and-passthrough" && recordingFallback !== null
            ? recordingFallback
            : fallback
        if (upstream === undefined) {
          // Defensive: constructor already guarded, but TS narrows nullably.
          throw new ReplayMissError(input, policy)
        }
        for await (const ev of upstream.stream(input)) {
          yield ev
        }
      }
      return run()
    },
  }
  return port
}
