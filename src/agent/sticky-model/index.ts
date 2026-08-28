/** Sticky model-per-mode slice barrel (ADR-0212). */
export { inMemoryStickyModelStore } from "./default-store"
export {
  defaultStickyModelPath,
  type FsBackedStickyModelStoreOpts,
  fsBackedStickyModelStore,
  readStickyModelSnapshotSync,
  STICKY_MODEL_FILENAME,
  StickyModelLoadCorruptionError,
  StickyModelWriteError,
  stickyModelPathFrom,
} from "./fs-backed-store"
export type {
  StickyModelKey,
  StickyModelLoadResult,
  StickyModelResolver,
  StickyModelSetResult,
  StickyModelStore,
} from "./port"
export { readStickyModelFrom, stickyModelKeyOf, stickyModelReadKeys } from "./port"
export { stickyModelResolver } from "./resolver"
export { sessionScopedStickyModelStore } from "./session-scoped-store"
