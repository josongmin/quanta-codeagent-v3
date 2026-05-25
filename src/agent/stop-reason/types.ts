/**
 * Stop-reason typed shapes (ADR-0242).
 *
 * Plane-clean leaf — no cross-slice imports. Encodes the Cursor 8-arm
 * `stop_reason` vocabulary as a closed union so any consumer switch is
 * forced into exhaustiveness, and the routed action as a closed 4-arm
 * union so loop-side wiring cannot silently grow new behaviors.
 *
 * StopReasonKind vocabulary (Cursor 3.2.16 verbatim):
 *   "end_turn"             — model voluntarily ended the turn.
 *   "tool_use"             — model emitted at least one tool_use block.
 *   "max_tokens"           — provider output cap hit mid-response.
 *   "refusal"              — model declined to act (provider refusal channel).
 *   "pause_turn"           — server-side tool resume pending (Anthropic).
 *   "content_filtered"     — provider's content filter terminated the turn.
 *   "guardrail_intervened" — provider guardrail (Bedrock/Vertex policy) tripped.
 *   "error"                — provider surfaced an in-band terminal error.
 *
 * StopAction vocabulary (closed; one arm per loop control flow path):
 *   "continue" — fall through to the legacy `decideOnAssembled` mapping
 *                (the policy did not classify the stop as terminal).
 *   "surface"  — non-fatal terminal for the loop; produce an `error`
 *                {@link RecoveryAction} carrying `reason` (the surface
 *                receives a legacy-shaped error outcome).
 *   "abort"    — terminal hard-stop with `reason`; identical loop control
 *                flow to "surface" today (one `error` outcome) but TAGGED
 *                so observability + HITL can distinguish a forced abort
 *                from a recoverable surface.
 *   "hitl"     — terminal pending human-in-the-loop escalation; today
 *                collapses to a tagged `error` outcome (no HITL queue
 *                routing yet — deferred follow-up). The tag carries
 *                `"stop-hitl"` so a future HITL-rerouter can recognise it
 *                without changing this surface.
 */

export type StopReasonKind =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "content_filtered"
  | "guardrail_intervened"
  | "error"

/** Canonical 8-arm tuple — used by tests as an exhaustive iterator and as a
 *  runtime guard against silent drift between the union and consumer switches.
 *  HELL-SR-01..08 iterate this tuple.  */
export const ALL_STOP_REASON_KINDS = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "refusal",
  "pause_turn",
  "content_filtered",
  "guardrail_intervened",
  "error",
] as const satisfies ReadonlyArray<StopReasonKind>

export type StopAction =
  | { readonly kind: "continue" }
  | { readonly kind: "surface"; readonly reason: string }
  | { readonly kind: "abort"; readonly reason: string }
  | { readonly kind: "hitl"; readonly reason: string }

/** Canonical 4-arm tuple — paired with ALL_STOP_REASON_KINDS so the hellgate
 *  battery can probe every (reason, action) crossing. */
export const ALL_STOP_ACTION_KINDS = [
  "continue",
  "surface",
  "abort",
  "hitl",
] as const satisfies ReadonlyArray<StopAction["kind"]>
