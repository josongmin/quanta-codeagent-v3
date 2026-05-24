/**
 * Fork-session slice barrel (ADR-0201). Plane-clean helper primitive.
 */

export type { DefaultSessionForkerOpts } from "./default-forker"
export { defaultSessionForker } from "./default-forker"
export type { Lineage, LineageEntry, LineageOpts } from "./lineage"
export { defaultLineage } from "./lineage"
export type { SessionForker } from "./port"
export type { ForkError, ForkedSessionHandle } from "./types"
export { ALL_FORK_ERROR_CODES } from "./types"
