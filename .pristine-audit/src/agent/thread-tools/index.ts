/**
 * Per-thread dynamic-tools slice barrel (ADR-0206). Plane-clean helper
 * primitive — no `@/agent/loop` / `@/agent/dispatch` reach-through.
 */

export { composeTools } from "./composer"
export type { InMemoryThreadToolStoreOpts } from "./in-memory-store"
export { inMemoryThreadToolStore } from "./in-memory-store"
export type { LazyResolver } from "./lazy-resolver"
export { defaultLazyResolver } from "./lazy-resolver"
export type { ListOpts, ThreadToolRegistry } from "./port"
export type { DynamicToolSpec, RegError, ResError } from "./types"
export { ALL_REG_ERROR_CODES, ALL_RES_ERROR_CODES } from "./types"
