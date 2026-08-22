/**
 * RFC-05 E5 — the ONE `request_user_input` availability PREDICATE (SSOT).
 *
 * This is the single policy function both the model tool-SPEC projection AND the
 * pre-DISPATCH admission consult resolve through, so visibility and execution can
 * never diverge (RFC-05 "Question availability and fail-closed policy": "The same
 * result controls both model-visible `request_user_input` specification and
 * execution-time dispatch; stale tool handles cannot bypass a later posture
 * change.").
 *
 * It is a PURE leaf: no IO, no clock, no host/agent references. It maps the two
 * facts that decide availability — the bound question knob (`askOutsidePlan`,
 * RFC-05 E1 `AskOutsidePlan`) and the current turn's plan-mode context — onto a
 * closed admitted/denied result with a machine reason. The agent bridge
 * (`@/agent/dispatch-guard/question-availability`) binds the LIVE values into a
 * duck-typed reader and calls this at both sites; the `@/tool` slice never
 * imports this module (the guard is agent-owned — RFC-05 §"All permission
 * invariants stay inside `@/permission`. `@/tool` must not import permission").
 *
 * Slice rules: `@/permission` leaf only — no sibling value imports required.
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

/** The turn's plan-mode context AS SEEN BY THIS BRIDGE.
 *
 *   - `"plan"`         — the turn is in plan collaboration mode. The mid-task
 *                        question tool is DESIGNED for plan mode (a missing fact
 *                        that turns the plan into a gamble), so it is always
 *                        available here regardless of the knob.
 *   - `"outside_plan"` — the turn is NOT in plan mode. Availability then depends
 *                        on the `askOutsidePlan` knob.
 *
 * ABSENCE (the `turnMode` field is `undefined` on {@link QuestionContext}) is the
 * UNKNOWN context: the real turn mode was not available at this bridge, so the
 * RESTRICTIVE answer is used (never permissive-by-default) — see
 * {@link canRequestUserInput}. */
export type QuestionTurnMode = "plan" | "outside_plan"

/** Why `request_user_input` is unavailable. A closed union — each arm is a
 *  machine reason a surface/model can branch on (never a prose match). */
export type QuestionDenyReason =
  /** `askOutsidePlan` is false AND the turn is (known to be) outside plan mode. */
  | "outside_plan_disabled"
  /** The turn's plan-mode context is unknown at this bridge AND `askOutsidePlan`
   *  is false ⇒ fail-safe deny (the restrictive result for an unknown context). */
  | "unknown_turn_mode"

/** Runtime tuple SSOT for {@link QuestionDenyReason}. A new reason must be added
 *  here too or the drift-guard test (`ALL_QUESTION_DENY_REASONS` vs the union)
 *  fails to compile. */
export const ALL_QUESTION_DENY_REASONS = [
  "outside_plan_disabled",
  "unknown_turn_mode",
] as const satisfies ReadonlyArray<QuestionDenyReason>

/** The closed availability result. Admitted ⇒ `{available:true}`; denied ⇒
 *  `{available:false, reason}` with a typed machine reason (no live mutation, no
 *  prose). */
export type QuestionAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: QuestionDenyReason }

/** The facts the predicate resolves over. `askOutsidePlan` is the bound question
 *  knob; `turnMode` is the current turn's plan-mode context, `undefined` when it
 *  is unknown at this bridge (⇒ restrictive). */
export interface QuestionContext {
  readonly askOutsidePlan: boolean
  readonly turnMode?: QuestionTurnMode | undefined
}

/** The shared admitted sentinel (frozen so a consumer cannot mutate it). */
export const QUESTION_AVAILABLE: QuestionAvailability = Object.freeze({ available: true })

/**
 * THE availability predicate (SSOT). Resolution order:
 *
 *   1. `turnMode === "plan"` ⇒ AVAILABLE. The tool is designed for plan mode;
 *      the knob only governs OUTSIDE plan.
 *   2. otherwise (outside plan, OR unknown context):
 *        - `askOutsidePlan === true`  ⇒ AVAILABLE (the operator opted the agent
 *          into asking anywhere — this is the current-behavior default, so a
 *          never-mutated posture is byte-identical: always available).
 *        - `askOutsidePlan === false` ⇒ DENIED. The reason distinguishes a KNOWN
 *          outside-plan turn (`outside_plan_disabled`) from an UNKNOWN context
 *          (`unknown_turn_mode`) — both fail-safe deny, so an unknown plan-mode
 *          context is NEVER permissive-by-default.
 *
 * Pure and total; the `undefined` `turnMode` arm is the fail-safe path.
 */
export const canRequestUserInput = (ctx: QuestionContext): QuestionAvailability => {
  if (ctx.turnMode === "plan") return QUESTION_AVAILABLE
  if (ctx.askOutsidePlan) return QUESTION_AVAILABLE
  return {
    available: false,
    reason: ctx.turnMode === undefined ? "unknown_turn_mode" : "outside_plan_disabled",
  }
}
