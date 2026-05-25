/**
 * Default policy — Cursor verbatim 8→4 mapping (ADR-0241).
 *
 * Routing table (Cursor source-of-truth):
 *   end_turn              → continue   (normal completion)
 *   tool_use              → continue   (loop dispatches tool blocks)
 *   max_tokens            → surface    (output limit hit; host nudges or stops)
 *   refusal               → surface    + metrics emit
 *   pause_turn            → surface    (server-tool resume wait)
 *   content_filtered      → abort      (moderation removed content; no retry)
 *   guardrail_intervened  → hitl       (policy boundary fired; human review)
 *   error                 → surface    (provider stream-level error)
 *
 * Metrics keys (emitted via the optional `ctx.metrics` sink):
 *   quanta.stop_reason.<reason>          — counter per stop_reason arm
 *   quanta.stop_reason.refusal           — refusal-specific (verbatim from
 *                                          ADR-0120 + HELL-SR-15 assertion)
 *
 * The policy is itself a constant — it carries no state, so callers can share
 * the singleton {@link DEFAULT_STOP_REASON_POLICY} or construct via
 * {@link buildDefaultStopReasonPolicy} when a test wants to spy.
 */

import type { StopReasonPolicy } from "./port"
import type { StopAction, StopReasonContext, StopReasonKind } from "./types"

/**
 * Pure mapping function — also the byte-identical heart of the default
 * policy. Returns the {@link StopAction} per the verbatim Cursor table.
 *
 * Unknown / not-yet-mapped reasons fall through to `"continue"` so an upstream
 * SDK introducing a new arm degrades to the historical no-op path (the loop
 * runs the 3-arm fallback). HELL-SR-09 locks this invariant.
 */
export const mapStopReason = (reason: StopReasonKind): StopAction => {
  switch (reason) {
    case "end_turn":
      return "continue"
    case "tool_use":
      return "continue"
    case "max_tokens":
      return "surface"
    case "refusal":
      return "surface"
    case "pause_turn":
      return "surface"
    case "content_filtered":
      return "abort"
    case "guardrail_intervened":
      return "hitl"
    case "error":
      return "surface"
    default: {
      // Exhaustiveness probe — if a new StopReasonKind arm is added without
      // updating this switch, `never` assignment fails at compile time. The
      // runtime fall-through returns "continue" so an SDK version drift
      // degrades to the historical no-op path rather than crashing.
      const _exhaustive: never = reason
      void _exhaustive
      return "continue"
    }
  }
}

const incCounter = (
  ctx: StopReasonContext,
  name: string,
): void => {
  if (ctx.metrics === undefined) return
  ctx.metrics.counter(name).inc(1)
}

/**
 * Build the default policy. Stateless — callers can also use the singleton
 * {@link DEFAULT_STOP_REASON_POLICY}. Construction is exposed for tests that
 * want fresh closure identity (otherwise referential equality across runs
 * confuses spy frameworks).
 */
export const buildDefaultStopReasonPolicy = (): StopReasonPolicy => ({
  handle(reason: StopReasonKind, ctx: StopReasonContext): StopAction {
    // Per-arm metric increment FIRST so a policy that surfaces / aborts still
    // produces the counter (otherwise the host loses the signal that the
    // refusal happened — HELL-SR-15 locks this for refusal).
    incCounter(ctx, `quanta.stop_reason.${reason}`)
    return mapStopReason(reason)
  },
})

/** Frozen singleton — the common case (no spy / no per-instance state). */
export const DEFAULT_STOP_REASON_POLICY: StopReasonPolicy =
  buildDefaultStopReasonPolicy()
