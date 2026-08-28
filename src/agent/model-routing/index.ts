/** Model routing (MR-00) — the session-scoped owner of "which model runs, and
 *  which model ran". See `./types.ts` for the contract and the two model facts. */

export {
  admitPersistedPicks,
  createModelRoutingAuthority,
  type ModelRoutingAuthorityArgs,
  type ModelRoutingCatalog,
} from "./authority"
export {
  createModelRoutingSession,
  type ModelRoutingSession,
  type ModelRoutingSessionArgs,
} from "./boot-snapshot"
export { resolveInitialSelection, resolveRequestModel } from "./precedence"
export {
  type ModelOption,
  type ModelRequestSnapshot,
  type ModelRoutingAuthority,
  type ModelRoutingMode,
  type ModelSelectionResult,
  type ModelSelectionSource,
  type ModelSelectionView,
  UnroutableModelError,
} from "./types"
