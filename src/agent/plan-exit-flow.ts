/**
 * Plan-exit flow orchestrator (ADR-0062 wire-up, absorb #3).
 *
 * Pure async orchestrator that bridges three already-shipped pieces:
 *
 *   1. {@link CollaborationMode} (`./mode.ts`) — the sticky 2-mode posture
 *      controlling whether mutating tools are admissible at the dispatch seam.
 *   2. {@link buildPlanExit} / {@link PlanExitOutcome} (`./plan-exit.ts`) — the
 *      3-way decision (`approved`/`rejected`/`changes_requested`) and its
 *      feedback invariant.
 *   3. {@link PlanExitPort} (defined HERE) — the host-supplied I/O seam that
 *      surfaces the plan to whoever decides (CLI prompt, IDE modal, RPC).
 *
 * The flow itself is a one-shot question to the port:
 *
 *     currentMode === "plan"     ⇒ ask the port for an outcome
 *     port returns               ⇒ revalidated through buildPlanExit
 *                                  (defends against bad-actor ports that
 *                                  forge `approved` with feedback or
 *                                  `changes_requested` without)
 *     returns the decision       ⇒ the CALLER applies the state change
 *                                  (mode transition / stay in plan)
 *                                  via planExitAllowsMutation +
 *                                  planExitStaysInPlan.
 *
 * The caller (loop or side-conversation) decides what to do next — this
 * module never reaches into mode state or message buffers itself. That split
 * keeps `plan-exit-flow.ts` pure (no I/O of its own, no `Date.now()`,
 * trivially testable with a mock port) while every actual state mutation
 * stays at exactly one site (the caller).
 *
 * ## Why a port and not a callback?
 *
 * A `PlanExitPort` interface (with one method) is the same shape as the rest
 * of the agent's I/O seams (`LLMPort`, `StreamPort`, `EmbedderPort`,
 * `PersistentStorePort`). A `port?.request(plan)` host can be:
 *   - injected through `AgentConfig.planExitPort` for the live loop,
 *   - mocked out trivially in tests,
 *   - swapped per-surface (CLI prompt vs IDE modal) without changing the flow.
 *
 * ## Default-OFF (byte-identical)
 *
 * The only code path that runs this flow is one where the caller has BOTH a
 * `CollaborationMode === "plan"` posture AND a non-`undefined` port. With no
 * port set, the legacy plan-mode behavior is untouched (sticky posture,
 * mutating tools blocked by `assertNotMutatingInPlanMode`, no exit). The flow
 * REFUSES to be called without a port (throws {@link PlanExitFlowError}) so a
 * mis-wired caller fails loudly rather than silently bypassing the gate.
 *
 * Slice isolation: imports only `./plan-exit`, `./mode`, `@/shared`.
 */

import { QuantaError } from "@/shared"
import type { CollaborationMode } from "./mode"
import {
  buildPlanExit,
  type PlanExitDecision,
  PlanExitInvariantError,
  type PlanExitOutcome,
} from "./plan-exit"

// ===========================================================================
// Port
// ===========================================================================

/**
 * Host-supplied surface that surfaces a plan to the operator and returns the
 * operator's chosen exit. Single-method by design — implementations are
 * trivially mockable, and the flow has exactly one I/O boundary.
 *
 * Contract:
 *   - `plan` is the agent's prepared plan text. Implementations MAY render it
 *     however they like (terminal prompt, modal, RPC) but MUST resolve with a
 *     {@link PlanExitOutcome} satisfying the feedback-iff-changes invariant.
 *     The flow re-validates via {@link buildPlanExit}, so a port that forges
 *     an invalid outcome is rejected — no silent normalization.
 *   - Reject the returned promise to surface a port-side failure (cancel,
 *     timeout, network error). The flow re-throws via {@link
 *     PlanExitPortFailedError}; the operator must see it.
 */
export interface PlanExitPort {
  request(plan: string): Promise<PlanExitOutcome>
}

// ===========================================================================
// Errors
// ===========================================================================

/**
 * Thrown when {@link runPlanExitFlow} is called without a port. The flow is
 * NEVER allowed to silently degrade to a default decision — a mis-wired
 * caller is a bug, not a graceful fallback case. The legacy "no port = no
 * exit at all" path lives in the CALLER (it simply never invokes the flow).
 */
export class PlanExitFlowError extends QuantaError {
  constructor(detail: string) {
    super("plan_exit_flow", `PlanExitFlowError: ${detail}`)
  }
}

/**
 * Thrown when the port's promise rejects, or when the port resolves with an
 * outcome that violates the feedback-iff-changes invariant. The original
 * error is preserved as `cause` (when available) so the operator can see the
 * underlying port-side failure.
 *
 * Wrapping (rather than re-throwing the original) ensures every flow failure
 * surfaces as a single named error class — callers (loop / side-conversation
 * / tests) only need to catch ONE type.
 */
export class PlanExitPortFailedError extends QuantaError {
  readonly originalMessage: string
  constructor(detail: string, cause?: unknown) {
    super("plan_exit_port_failed", `PlanExitPortFailedError: ${detail}`)
    this.originalMessage =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : cause === undefined
            ? ""
            : String(cause)
    if (cause !== undefined) {
      // `cause` is standard since ES2022 — set conditionally via Object.assign
      // to stay friendly with exactOptionalPropertyTypes and avoid passing
      // explicit-undefined.
      Object.assign(this, { cause })
    }
  }
}

/**
 * Thrown when {@link runPlanExitFlow} is called with `currentMode !== "plan"`.
 * The flow is only meaningful in plan posture — calling it in `default` mode
 * indicates a caller bug (a non-plan loop should not be eliciting a plan
 * exit), not a graceful "decision is automatically approved" case.
 */
export class PlanExitNotInPlanModeError extends QuantaError {
  readonly currentMode: CollaborationMode
  constructor(currentMode: CollaborationMode) {
    super(
      "plan_exit_not_in_plan_mode",
      `PlanExitNotInPlanModeError: currentMode=${currentMode}; ` +
        `plan-exit flow is only meaningful when currentMode==="plan".`,
    )
    this.currentMode = currentMode
  }
}

// ===========================================================================
// Result
// ===========================================================================

/**
 * Result of running the plan-exit flow. The {@link PlanExitDecision} is the
 * primary signal; `feedback` is present iff the decision is
 * `changes_requested` (mirrors {@link PlanExitOutcome}).
 *
 * The caller uses `planExitAllowsMutation(decision)` to decide whether to
 * transition collaboration mode to `default`; every other decision stays in plan
 * (`planExitStaysInPlan`), and only `changes_requested` carries feedback into the
 * next turn.
 */
export interface PlanExitFlowResult {
  readonly decision: PlanExitDecision
  readonly feedback?: string
}

// ===========================================================================
// Orchestrator
// ===========================================================================

/**
 * One-shot plan-exit flow.
 *
 * Preconditions (enforced — no silent fallback):
 *   - `currentMode === "plan"` (else {@link PlanExitNotInPlanModeError}).
 *   - `port !== undefined` (else {@link PlanExitFlowError}). The DEFAULT-OFF
 *     guarantee is preserved by the CALLER never invoking this function when
 *     the host did not inject a port.
 *
 * Returns a {@link PlanExitFlowResult} carrying the decision the caller must
 * act on. The flow does NOT itself transition collaboration mode or queue
 * follow-ups — that is the caller's responsibility (the caller owns the mode
 * state and the follow-up queue, and we keep those mutations at exactly one
 * site).
 *
 * Failure modes:
 *   - Port rejection ⇒ {@link PlanExitPortFailedError}, cause preserved.
 *   - Port returns an invariant-violating outcome ⇒
 *     {@link PlanExitPortFailedError} (wraps the underlying
 *     {@link PlanExitInvariantError}).
 *   - Both failures are surfaced to the operator — NEVER swallowed.
 */
export const runPlanExitFlow = async (
  currentMode: CollaborationMode,
  plan: string,
  port: PlanExitPort | undefined,
): Promise<PlanExitFlowResult> => {
  if (currentMode !== "plan") {
    throw new PlanExitNotInPlanModeError(currentMode)
  }
  if (port === undefined) {
    throw new PlanExitFlowError(
      "no port injected — the flow MUST NOT be called when planExitPort is undefined " +
        "(byte-identical default-OFF posture is preserved by the caller skipping the call).",
    )
  }

  let raw: PlanExitOutcome
  try {
    raw = await port.request(plan)
  } catch (e) {
    throw new PlanExitPortFailedError(
      e instanceof Error ? `port.request rejected: ${e.message}` : "port.request rejected",
      e,
    )
  }

  // Re-validate via buildPlanExit. A bad-actor port cannot forge an
  // `approved` outcome with feedback, nor `changes_requested` without it.
  let validated: PlanExitOutcome
  try {
    validated = buildPlanExit(
      raw.feedback === undefined
        ? { decision: raw.decision }
        : { decision: raw.decision, feedback: raw.feedback },
    )
  } catch (e) {
    if (e instanceof PlanExitInvariantError) {
      throw new PlanExitPortFailedError(
        `port returned an outcome that violates the feedback-iff-changes invariant: ${e.message}`,
        e,
      )
    }
    throw e
  }

  // Build the result without ever assigning explicit `undefined` to
  // `feedback` (exactOptionalPropertyTypes).
  return validated.feedback === undefined
    ? { decision: validated.decision }
    : { decision: validated.decision, feedback: validated.feedback }
}
