/**
 * Default {@link StopReasonPolicy} (ADR-0242). The Cursor 3.2.16 8-arm
 * `stop_reason` routing table verbatim:
 *
 *   end_turn / tool_use                                  → continue
 *   max_tokens / refusal / pause_turn / error            → surface
 *   content_filtered                                     → abort
 *   guardrail_intervened                                 → hitl
 *
 * Unknown / unrecognised inputs collapse to `continue` (HELL-SR-09) so the
 * legacy `decideOnAssembled` mapping retains the final word — this policy
 * is a *typed router*, not a vocabulary gatekeeper.
 *
 * Pure leaf — closures only over the constant reasons + the canonical lookup.
 * The factory takes no options today; the signature is `() => StopReasonPolicy`
 * so a future config-driven variant can be threaded without changing the
 * wire site (HELL-SR-11).
 */

import type { StopReasonPolicy } from "./port"
import type { StopAction, StopReasonKind } from "./types"

// Pre-built frozen action literals — reused across calls so the policy
// allocates zero objects per `handle()`. The strings are the Cursor
// vocabulary verbatim; do not abbreviate.
const CONTINUE: StopAction = Object.freeze({ kind: "continue" })
const SURFACE_MAX_TOKENS: StopAction = Object.freeze({
  kind: "surface",
  reason: "provider stop_reason=max_tokens (output cap hit)",
})
const SURFACE_REFUSAL: StopAction = Object.freeze({
  kind: "surface",
  reason: "provider stop_reason=refusal (model declined)",
})
const SURFACE_PAUSE_TURN: StopAction = Object.freeze({
  kind: "surface",
  reason: "provider stop_reason=pause_turn (server-tool resume pending)",
})
const SURFACE_ERROR: StopAction = Object.freeze({
  kind: "surface",
  reason: "provider stop_reason=error (in-band terminal)",
})
const ABORT_CONTENT_FILTERED: StopAction = Object.freeze({
  kind: "abort",
  reason: "provider stop_reason=content_filtered (content filter tripped)",
})
const HITL_GUARDRAIL: StopAction = Object.freeze({
  kind: "hitl",
  reason: "provider stop_reason=guardrail_intervened (guardrail policy tripped)",
})

/** Canonical routing map. Exported (read-only) so HELL-SR can drive an
 *  exhaustive cross-check against {@link ALL_STOP_REASON_KINDS}. */
export const DEFAULT_STOP_REASON_ROUTING: Readonly<Record<StopReasonKind, StopAction>> =
  Object.freeze({
    end_turn: CONTINUE,
    tool_use: CONTINUE,
    max_tokens: SURFACE_MAX_TOKENS,
    refusal: SURFACE_REFUSAL,
    pause_turn: SURFACE_PAUSE_TURN,
    error: SURFACE_ERROR,
    content_filtered: ABORT_CONTENT_FILTERED,
    guardrail_intervened: HITL_GUARDRAIL,
  })

/** Construct the default stop-reason policy. The returned `handle` is pure:
 *  no closure over mutable state, no allocation per call (returns frozen
 *  literals from the lookup map). */
export const defaultStopReasonPolicy = (): StopReasonPolicy => ({
  handle(stopReason: string): StopAction {
    // Narrow + look up. Anything outside the closed vocabulary collapses to
    // `continue` so the legacy mapping in `recovery.decideOnAssembled` keeps
    // the final word (HELL-SR-09).
    const action = (DEFAULT_STOP_REASON_ROUTING as Readonly<Record<string, StopAction>>)[stopReason]
    return action ?? CONTINUE
  },
})
