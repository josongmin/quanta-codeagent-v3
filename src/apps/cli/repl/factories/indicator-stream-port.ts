import { emitOperatorNotice, errMessage } from "@/shared"
import type { StreamPort } from "@/stream"
import type { TurnIndicator } from "../../turn-indicator"

/** S3 (jul-03) — optional per-turn usage observer teed onto the same
 *  indicator port. The `/context` gauge's reasoning-token annotation needs
 *  the LIVE `usage` AgentEvent's `reasoningTokens` split (OpenAI-Responses-
 *  only), but the only production seam that already consumes `usage` events
 *  on the interactive surface is THIS port. The composition root hands in the
 *  `ContextUsageHolder.observeUsage` bound method so a real end-of-turn
 *  `usage` event feeds the gauge holder. Absent ⇒ no feed (byte-identical:
 *  the observer is only wired when the caller passes it, and the port itself
 *  is only teed when the indicator is enabled — see
 *  `buildTurnIndicatorAndStream`). The observe call is inside the SAME
 *  swallow-all try/catch so a holder throw can never poison the recorder leg. */
export interface IndicatorUsageObserver {
  readonly observeUsage: (usage: { readonly reasoningTokens?: number }) => void
}

/** Bridge `AgentEvent`s into the live turn indicator. Implements `StreamPort`
 *  so it can be teed alongside the existing recorder/stdout port — the
 *  upstream emit path is unchanged (TeeStream forwards every event to every
 *  port in order) and the indicator just sips the ones it cares about.
 *
 *  Sliced taxonomy (only events that move the indicator state):
 *    - `assistant_text` / `tool_call` ⇒ `markFirstChunk` (first-chunk seam —
 *      the first emit of either is the moment the model started producing
 *      something the user can see; flips "thinking…" → "streaming").
 *      Idempotent on the indicator side.
 *    - `output_progress` ⇒ `updateUsage` with the LIVE cumulative output count
 *      (the rising "· N tokens"). `exact` is threaded through so an estimated
 *      tail renders with a `~` prefix. This is the vendor-agnostic live feed —
 *      synthesized by the `withLiveUsage` decorator from normalized
 *      text/thinking deltas, upgraded to provider-authoritative when available.
 *    - `usage` ⇒ `updateUsage` with the cumulative token counts (authoritative;
 *      snaps the count exact at end-of-turn). Cost stays OFF for now (no
 *      per-model price table is wired at this surface; a future round can hand
 *      a `costUsd` in). S3 — ALSO forwards the event's `reasoningTokens` split
 *      to the optional `usageObserver` (the `/context` gauge holder) when one
 *      is wired.
 *  Every other event is ignored — the indicator is purely a UX surface, not
 *  a trajectory recorder. Errors in the indicator are swallowed in place so
 *  a faulty render can never poison the recorder path. */
/** The sliced-taxonomy forward (see the module doc above). Extracted from the
 *  emit closure so the WS-G latch wrapper stays under the complexity cap. */
const forwardIndicatorEvent = (
  ind: TurnIndicator,
  usageObserver: IndicatorUsageObserver | undefined,
  event: Parameters<StreamPort["emit"]>[0],
): void => {
  if (event.type === "assistant_text" || event.type === "tool_call") {
    ind.markFirstChunk()
    return
  }
  if (event.type === "output_progress") {
    // A1 — a subagent's live count must not overwrite the ROOT's gauge. The
    // check is on the EVENT's provenance, not the port's config: parent and
    // child share one stream, so the event is the only thing that knows.
    // Events WITHOUT agentKind (legacy/synthetic producers) pass as before.
    if (event.agentKind === "subagent") return
    ind.updateUsage({ outputTokens: event.outputTokens, exact: event.exact })
    return
  }
  if (event.type === "usage") {
    // A1 — same rule for the authoritative end-of-turn snap AND the
    // reasoning-split observer: both describe the CHILD's request, and
    // feeding either into the root's /context gauge misreports the window.
    if (event.agentKind === "subagent") return
    ind.updateUsage({
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
    })
    // S3 — feed the reasoning-token split into the `/context` gauge holder.
    // Conditional-spread so an ABSENT split (Anthropic / no-reasoning
    // provider) forwards `{}` (exactOptionalPropertyTypes: we never assign
    // an explicit `undefined`), while an explicit `0` rides through
    // verbatim — the holder's own `!== undefined` guard then decides
    // retention. No synthetic value is ever fabricated here.
    usageObserver?.observeUsage(
      event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {},
    )
  }
}

export const buildIndicatorPort = (
  ind: TurnIndicator,
  usageObserver?: IndicatorUsageObserver,
): StreamPort => {
  // WS-G (UUX-1-18) — the swallow below is a DOUBLE-swallow: TeeStream never
  // sees the failure (by design, so it is not tracked as a degraded recorder
  // leg), which used to mean ZERO operator signal for a broken indicator.
  // Latch one warn notice per port lifetime on the first internal failure.
  let degradeNotified = false
  return {
    emit: (event): void => {
      try {
        forwardIndicatorEvent(ind, usageObserver, event)
      } catch (e) {
        // Intentional: an indicator failure must not surface as an emit error
        // (TeeStream would otherwise track it as a degraded record). WS-G — but
        // it must not be INVISIBLE either: one latched operator notice.
        if (!degradeNotified) {
          degradeNotified = true
          emitOperatorNotice({
            severity: "warn",
            source: "turn-indicator",
            message: `turn indicator degraded: ${errMessage(e)}`,
            hint: "spinner/token readout may be stale for the rest of the session",
          })
        }
      }
    },
  }
}
