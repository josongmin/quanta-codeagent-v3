/**
 * Cross-slice mirror — keep in sync with @/agent/plan/types.ts; adding fields
 * there MUST also add here. RFC §3.1 slice isolation forbids the import.
 *
 * Plan + PlanDelta are the host-facing observation shapes for the plan-mode
 * P3 events (`plan_created` / `plan_updated` / `plan_snapshot`). They are
 * STRUCTURALLY identical to the agent-slice types (same field names + same
 * shapes); we duplicate them here so the stream slice does not back-reference
 * the agent slice (slice isolation invariant). A future P4 cluster that lands
 * `@/agent/plan/types.ts` MUST re-shape both sites in lock-step.
 */
export {};
