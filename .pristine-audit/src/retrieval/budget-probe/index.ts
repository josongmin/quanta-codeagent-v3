/**
 * `@/retrieval/budget-probe` sub-barrel — ADR-0274.
 *
 * Public surface: the broadened `BudgetProbe` port, the closed-union
 * `BudgetProbeError` taxonomy + thrown wrapper, and the two factory
 * seams (ledger-bridged for production, static for tests). Pure leaf
 * sub-slice — no imports from sibling `@/retrieval/{pipeline,
 * embedders, ...}` files, no `@/agent` imports.
 *
 * Default-OFF: nothing in @/agent / @/runner / @/apps constructs a
 * probe at ship time. Source-text invariant enforced by HELL-BP-09.
 */

export {
  createBudgetProbeFromLedger,
  type FromLedgerOpts,
  type LedgerSnapshotSource,
} from "./from-ledger"
export type { BudgetProbe } from "./port"
export { createStaticBudgetProbe, type StaticBudgetProbeOpts } from "./static-probe"
export { type BudgetProbeError, BudgetProbeException } from "./types"
