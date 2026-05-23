/**
 * Steering rejection-reason vocabulary (ADR-0030) — extracted as a tiny
 * dependency-free leaf so both `steering.ts` (the decision engine) and
 * `conversation-action.ts` (the layer that REUSES the reason set) can import
 * it WITHOUT forming an evaluation-time import cycle.
 *
 * `steering.ts` re-exports both symbols below so the historical
 * `@/agent/steering` import surface is unchanged.
 */
/** All rejection reasons enumerated — used by tests for exhaustive
 *  coverage assertions without `as const` gymnastics. */
export const ALL_REJECTION_REASONS = [
    "no_active_turn",
    "expected_turn_mismatch",
    "non_steerable_review",
    "non_steerable_compact",
    "non_steerable_standalone",
    "empty_input",
    "input_too_large",
    "interrupted",
];
