/**
 * Session-startup prewarm + Time-To-First-Message wiring (ADR-0452 — Codex
 * `session_startup_prewarm` absorption).
 *
 * Two collaborators, both gated together on `config.prewarm.enabled`:
 *
 *   1. {@link runSessionPrewarm} — fired ONCE at session start (before the
 *      first turn). Stamps the session-start instant on the injected clock,
 *      best-effort warms the LLM connection (`prewarmLlm`; a no-op unless the
 *      adapter implements the optional `prewarm` capability), and records the
 *      prewarm outcome + duration. Returns a {@link TtfmMarker} the loop hands
 *      to the stream dispatcher.
 *
 *   2. {@link TtfmMarker} — a once-fire marker. The stream dispatcher calls
 *      `markFirstDispatch()` at the LLM-request boundary; the FIRST call
 *      records TTFM = `now() - startedAt` via the recorder; every later call
 *      is a no-op (so TTFM is a single per-session value, Codex
 *      `age_at_first_turn_ms` parity).
 *
 * DEFAULT-OFF: the loop only constructs any of this when `config.prewarm` is
 * present and `enabled === true`. Absent ⇒ no clock read, no prewarm call, no
 * marker, no metric — byte-identical to the pre-slice path.
 *
 * All time comes from the INJECTED clock (`config.prewarm.now`, defaulting to
 * `Date.now`) so TTFM is deterministic under a fake clock in tests. The loop
 * body itself reads no real timer for this slice.
 */

import type { LLMPort } from "@/llm"
import { prewarmLlm } from "@/llm"
import type { AgentRecorder } from "./metrics"

/** Once-fire TTFM marker handed to the stream dispatcher. */
export interface TtfmMarker {
  /** Record TTFM on the FIRST call; no-op on every subsequent call. */
  markFirstDispatch(): void
}

/** Inert marker for the default-OFF path — `markFirstDispatch` does nothing.
 *  Returned only when the caller wants a non-undefined handle; the loop omits
 *  the `ttfm` slot entirely when prewarm is off, so this is unused there. */
export const NOOP_TTFM_MARKER: TtfmMarker = { markFirstDispatch: () => {} }

interface PrewarmArgs {
  /** The session's `LLMPort` (the live `cfg.llm`, after any wrapping). */
  readonly llm: LLMPort
  /** Loop recorder; absent ⇒ metrics are skipped but prewarm still runs. */
  readonly recorder: AgentRecorder | undefined
  /** Injected wall-clock (epoch ms). */
  readonly now: () => number
  /** Optional abort signal so a slow warm never delays the first turn. */
  readonly warmSignal?: AbortSignal
  /** Best-effort error sink (loop logger). */
  readonly onError?: (message: string) => void
}

/**
 * Run the session-startup prewarm and return a {@link TtfmMarker}.
 *
 * Best-effort: a failing connection warm is swallowed (recorded as the
 * `"failed"` outcome) and the marker is still returned so TTFM is recorded on
 * the first turn regardless. NEVER throws.
 */
export const runSessionPrewarm = async (args: PrewarmArgs): Promise<TtfmMarker> => {
  const startedAt = args.now()

  // --- Connection warm (best-effort, no-op unless the adapter opts in) ------
  const warmBeganAt = args.now()
  const outcome = await prewarmLlm(args.llm, {
    ...(args.warmSignal !== undefined ? { signal: args.warmSignal } : {}),
    ...(args.onError !== undefined ? { onError: args.onError } : {}),
  })
  // duration is 0 for the `"skipped"` outcome (the helper never touched the
  // port), which faithfully reflects "no warm happened".
  const warmDurationMs = outcome === "skipped" ? 0 : Math.max(0, args.now() - warmBeganAt)
  args.recorder?.prewarm(outcome, warmDurationMs)

  // --- Once-fire TTFM marker ------------------------------------------------
  let fired = false
  return {
    markFirstDispatch: () => {
      if (fired) return
      fired = true
      const ttfm = Math.max(0, args.now() - startedAt)
      args.recorder?.timeToFirstMessage(ttfm)
    },
  }
}
