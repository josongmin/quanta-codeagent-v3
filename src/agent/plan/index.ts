/**
 * `@/agent/plan` barrel — public surface of the SOTA++ plan-mode slice
 * (ADR-0093 draft). Keep this surface MINIMAL: cross-slice consumers should
 * use the duck-typed `ToolContext.planMutator` seam in `@/tool/types.ts`
 * (RFC §3.1 slice isolation; biome `noRestrictedImports` enforces).
 */

export { findCycle, topologicalSort, validateDag } from "./dag"
export {
  addTodos,
  createPlan,
  removeTodos,
  reorderPhases,
  updateMeta,
  updateTodos,
} from "./mutations"
export {
  fromSnapshot,
  PLAN_SNAPSHOT_SCHEMA,
  type PlanSnapshot,
  type PlanSnapshotParseError,
  toSnapshot,
} from "./snapshot"
export {
  type CreateInMemoryPlanStoreOpts,
  createInMemoryPlanStore,
  type PlanStore,
} from "./state"
export {
  isValidTransition,
  TRANSITION_MATRIX,
} from "./transitions"
export * from "./types"
