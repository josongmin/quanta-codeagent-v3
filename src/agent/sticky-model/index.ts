/** Sticky model-per-mode slice barrel (ADR-0212). */
export { inMemoryStickyModelStore } from "./default-store"
export {
  defaultStickyModelPath,
  type FsBackedStickyModelStoreOpts,
  fsBackedStickyModelStore,
  readStickyModelSnapshotSync,
  STICKY_MODEL_FILENAME,
  STICKY_MODEL_LOCK_SUFFIX,
  StickyModelLoadCorruptionError,
  StickyModelWriteError,
  stickyModelLockPathOf,
  stickyModelPathFrom,
} from "./fs-backed-store"
export {
  isStickyModelKeyInScope,
  parseStickyModelStorageKey,
  STICKY_MODEL_KEY_MAX_LENGTH,
  type StickyModelStorageKey,
} from "./key-codec"
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
