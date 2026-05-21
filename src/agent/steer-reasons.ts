/**
 * Steering rejection-reason vocabulary (ADR-0030) — extracted as a tiny
 * dependency-free leaf so both `steering.ts` (the decision engine) and
 * `conversation-action.ts` (the layer that REUSES the reason set) can import
 * it WITHOUT forming an evaluation-time import cycle.
 *
 * `steering.ts` re-exports both symbols below so the historical
 * `@/agent/steering` import surface is unchanged.
 */

/**
 * Closed set of reasons the steering decision returns when it rejects. Each
 * is observable on the trajectory; consumers MUST handle every literal
 * (exhaustive switch). The 8th historical reason — `standalone_turn` — is
 * split here per ADR-0030 into three precise `non_steerable_*` reasons so
 * the surface knows exactly which internal kind refused; that is closer to
 * Codex's `ActiveTurnNotSteerable { turn_kind }` shape than a single flag.
 */
export type SteerRejectionReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "non_steerable_review"
  | "non_steerable_compact"
  | "non_steerable_standalone"
  | "empty_input"
  | "input_too_large"
  | "interrupted"

/** All rejection reasons enumerated — used by tests for exhaustive
 *  coverage assertions without `as const` gymnastics. */
export const ALL_REJECTION_REASONS: ReadonlyArray<SteerRejectionReason> = [
  "no_active_turn",
  "expected_turn_mismatch",
  "non_steerable_review",
  "non_steerable_compact",
  "non_steerable_standalone",
  "empty_input",
  "input_too_large",
  "interrupted",
]
