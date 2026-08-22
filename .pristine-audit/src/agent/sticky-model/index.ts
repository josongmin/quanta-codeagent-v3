/** Sticky model-per-mode slice barrel (ADR-0212). */
export { inMemoryStickyModelStore } from "./default-store"
export {
  defaultStickyModelPath,
  type FsBackedStickyModelStoreOpts,
  fsBackedStickyModelStore,
  StickyModelLoadCorruptionError,
  StickyModelWriteError,
} from "./fs-backed-store"
export type {
  StickyModelLoadResult,
  StickyModelResolver,
  StickyModelSetResult,
  StickyModelStore,
} from "./port"
export { stickyModelResolver } from "./resolver"
