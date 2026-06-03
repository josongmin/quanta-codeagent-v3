/**
 * N-phase HITL — typed shapes (ADR-0243; renumbered from 0242 collision-avoidance).
 *
 * Generalization of ADR-0063 (plan-exit 3-way) into an N-phase state machine
 * with per-phase feedback gates. Mirrors Cursor `AiProjectService(8)`'s
 * (init→clarify→plan→feedback→breakdown→…) pattern.
 *
 * Plane-clean leaf — depends ONLY on `@/shared`. The N-phase slice is a
 * sibling of plan-exit{,-flow}: it does NOT import them and does NOT modify
 * them. Pre-existing plan-exit behavior is byte-identical.
 *
 * Constraint (per ADR-0243 task spec):
 *   - exactOptionalPropertyTypes: OMIT — optional fields are omitted when not
 *     present (never set to explicit `undefined`).
 *
 * Closed-port + default-OFF: callers that never inject an {@link
 * import("./port").NPhaseDriver} see no behavior change.
 */

import { QuantaError } from "@/shared"

// ===========================================================================
// Core identifiers
// ===========================================================================

/** Phase identifier — a string key that is unique within a single driver's
 *  {@link PhaseSpec}[] sequence. Closed over the host's enum at the call site.
 *
 *  The driver enforces "no unknown id" at runtime via {@link UnknownPhaseError}
 *  — this lets host enums (e.g. `"init" | "clarify" | "plan"`) be passed as
 *  branded strings without exposing a generic-parameter on every API. */
export type PhaseId = string

/** Static description of one phase in the sequence. Pure data; the driver
 *  owns dynamic state (current id, feedback ledger).
 *
 *  Invariants:
 *   - `id` is unique across the spec list.
 *   - `requiresFeedback === true` ⇒ transition() into the NEXT phase from this
 *     one is rejected with {@link FeedbackRequiredError} until feedback()
 *     records an explicit positive outcome for this phase.
 *   - `allowSkip === true` ⇒ transition() may target a NON-adjacent later
 *     phase ("skip ahead"). Default `false` enforces strictly sequential.
 */
export interface PhaseSpec {
  readonly id: PhaseId
  readonly name: string
  readonly requiresFeedback: boolean
  readonly allowSkip: boolean
}

// ===========================================================================
// Transition + feedback values
// ===========================================================================

/** Successful transition outcome. `from`/`to` are the phase ids BEFORE/AFTER
 *  the move. `direction` makes the kind of move first-class:
 *   - `"forward"`  — moved to a later phase (the default, sequential).
 *   - `"skip"`     — moved past one or more allowSkip phases.
 *   - `"rollback"` — moved to a previous phase (driven by negative feedback). */
export interface PhaseTransition {
  readonly from: PhaseId
  readonly to: PhaseId
  readonly direction: "forward" | "skip" | "rollback"
}

/** All transition directions, as a runtime constant for exhaustive testing. */
export const ALL_TRANSITION_DIRECTIONS: ReadonlyArray<PhaseTransition["direction"]> = [
  "forward",
  "skip",
  "rollback",
]

/** Operator feedback against the CURRENT phase. `positive: true` unlocks
 *  transition() out of `requiresFeedback`-gated phases. `positive: false`
 *  triggers a rollback to the previous phase (HELL-NP-09).
 *
 *  `context` is an open, schema-less bag preserved verbatim across the
 *  feedback ledger. Callers that round-trip a `files_to_modify: string[]`
 *  must see it returned exact-equal (HELL-NP-15). */
export interface FeedbackResult {
  readonly phase: PhaseId
  readonly positive: boolean
  /** Optional payload preserved verbatim by the driver. Omitted when caller
   *  does not provide one (NOT set to `undefined`). */
  readonly context?: Readonly<Record<string, unknown>>
}

// ===========================================================================
// Errors — typed, exhaustive
// ===========================================================================

/** Discriminator for {@link TransitionError} arms. Closed. */
export type TransitionErrorCode =
  | "unknown-phase"
  | "feedback-required"
  | "skip-not-allowed"
  | "no-next-phase"
  | "backward-not-permitted"

/** All transition error codes (exhaustive testing). `as const satisfies` so the
 *  drift guard sees the literal tuple — a plain `ReadonlyArray<Code>` annotation
 *  widens `[number]` back to the union and makes the reverse Assert trivially
 *  true (useless). */
export const ALL_TRANSITION_ERROR_CODES = [
  "unknown-phase",
  "feedback-required",
  "skip-not-allowed",
  "no-next-phase",
  "backward-not-permitted",
] as const satisfies readonly TransitionErrorCode[]
type _AssertTxn<T extends true> = T
export type _TransitionCodesDriftGuard = _AssertTxn<
  TransitionErrorCode extends (typeof ALL_TRANSITION_ERROR_CODES)[number] ? true : false
>

/** Typed transition failure. `code` is the closed enum; `detail` is a
 *  human-readable string for logging only (NEVER parsed).
 *
 *  Note: this narrows the inherited `QuantaError.code: string` to the closed
 *  enum {@link TransitionErrorCode}. The base class still stores the string
 *  form (`n_phase_transition_${code}`) for legacy code paths that key on
 *  free-form codes; the override surfaces the enum to typed consumers. */
export class TransitionError extends QuantaError {
  override readonly code: TransitionErrorCode
  constructor(code: TransitionErrorCode, detail: string) {
    super(`n_phase_transition_${code.replace(/-/g, "_")}`, `TransitionError(${code}): ${detail}`)
    this.code = code
  }
}

/** Discriminator for {@link FeedbackError} arms. Closed. */
export type FeedbackErrorCode = "unknown-phase" | "phase-mismatch"

/** All feedback error codes (exhaustive testing). `as const satisfies` for the
 *  drift guard (see ALL_TRANSITION_ERROR_CODES). */
export const ALL_FEEDBACK_ERROR_CODES = [
  "unknown-phase",
  "phase-mismatch",
] as const satisfies readonly FeedbackErrorCode[]
type _AssertFb<T extends true> = T
export type _FeedbackCodesDriftGuard = _AssertFb<
  FeedbackErrorCode extends (typeof ALL_FEEDBACK_ERROR_CODES)[number] ? true : false
>

/** Typed feedback failure. Narrows `QuantaError.code` to {@link FeedbackErrorCode}.
 *  Base stores the string form (`n_phase_feedback_${code}`); override surfaces
 *  the enum to typed consumers. */
export class FeedbackError extends QuantaError {
  override readonly code: FeedbackErrorCode
  constructor(code: FeedbackErrorCode, detail: string) {
    super(`n_phase_feedback_${code.replace(/-/g, "_")}`, `FeedbackError(${code}): ${detail}`)
    this.code = code
  }
}

/** Convenience — used to map errors back through `code`. */
export const isTransitionError = (e: unknown): e is TransitionError => e instanceof TransitionError
export const isFeedbackError = (e: unknown): e is FeedbackError => e instanceof FeedbackError

// Re-export the legacy name `UnknownPhaseError` for callers wanting a
// narrower handle on the "unknown id" case. It is the SAME class — pattern
// match on `.code === "unknown-phase"` to discriminate.
export const UnknownPhaseError = TransitionError
