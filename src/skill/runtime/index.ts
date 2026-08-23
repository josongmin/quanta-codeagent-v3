/**
 * RFC-06 F1 — `@/skill/runtime` internal barrel (re-exported through the slice
 * barrel `@/skill`). The live skill runtime authority: one atomic owner of the
 * registry + admin policy + durable user-disabled set + a unified revision, with
 * three consistent projections (active / searchable / management), CAS
 * setEnabled, and a versioned fail-closed disabled-set store behind a port.
 */

export {
  copySkillMarkdown,
  DEFAULT_SKILL_COPY_MAX_BYTES,
  revealSkill,
  type SkillActionPorts,
  type SkillCopyRejection,
  type SkillCopyResult,
  type SkillRevealRejection,
  type SkillRevealResult,
  setSkillEnabledAction,
} from "./actions"
export {
  createFileLock,
  DEFAULT_DISABLED_LOCK_RETRY_INTERVAL_MS,
  DEFAULT_DISABLED_LOCK_STALE_THRESHOLD_MS,
  DEFAULT_DISABLED_LOCK_TIMEOUT_MS,
  type DisabledStoreLock,
  type DisabledStoreLockOpts,
  disabledSetLockPath,
} from "./adapters/disabled-store-lock"
export {
  createInMemoryDisabledStore,
  createJsonDisabledStore,
  type DisabledStoreFs,
  nodeDisabledStoreFs,
} from "./adapters/json-disabled-store"
export {
  createNodeSkillActionPorts,
  nodeRevealCapability,
  resolveRevealCapability,
  type SkillRevealSurface,
} from "./adapters/node-skill-actions"
export type {
  SkillRuntimeAuthority,
  SkillRuntimeAuthorityDeps,
  SkillSetEnabledRejection,
  SkillSetEnabledResult,
} from "./authority"
export { createSkillRuntimeAuthority } from "./authority"
export type {
  DisabledSetMutateOutcome,
  DisabledSetTransform,
  DisabledStorePort,
  PersistedDisabledSet,
} from "./disabled-store-port"
export {
  DISABLED_SET_SCHEMA_VERSION,
  decodeDisabledSet,
  emptyDisabledSet,
} from "./disabled-store-port"
export type { EffectiveDisable } from "./projections"
export { deriveSkillProjections, effectiveDisable } from "./projections"
export type { SkillRuntimeReaderOptions } from "./reader"
export { createSkillRuntimeReader } from "./reader"
export type {
  ManagedSkill,
  SkillActiveInventoryEntry,
  SkillDisableReason,
  SkillRuntimeReader,
  SkillRuntimeView,
} from "./types"
export { SKILL_DISABLE_REASONS } from "./types"
