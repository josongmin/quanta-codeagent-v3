/**
 * `@/runner/assemble/session-authorities` — RFC-01 A2 session-authority graph
 * barrel. The one multi-domain constructor seam (blueprint §3); A2 seeds it with
 * the task/question/attention arms, later packets extend it.
 */

export {
  createRegistryBlockerDependencyResolver,
  type RegistryBlockerDependencySources,
} from "./blocker-dependency-resolver"
export { buildSessionAuthorities } from "./build"
// RFC-03 C2 — the single objective-authority builder + persistence encode/decode
// adapter. Surfaces construct the per-session objective HERE (no surface-local
// `createObjectiveStore()`); the encode/decode adapter bridges the live authority
// and the plain-JSON `@/session` DTO.
export type { BuildObjectiveAuthorityInput } from "./build-objective"
export { buildObjectiveAuthority, encodeObjectiveSnapshot } from "./build-objective"
// RFC-05 E3 — the single posture-authority builder + the behavior-live
// permission-mode delegating adapter. Surfaces construct the per-session posture
// HERE (no surface-local mode cell); the adapter routes every mode read/write
// through the durable authority.
export {
  type BuildPostureAuthorityInput,
  type BuildThreadPostureBindingInput,
  buildLivePermissionModeState,
  buildPostureAuthority,
  buildThreadPostureBinding,
  createInMemoryPosturePersistence,
  createPermissionModeAdapter,
  createSeededPosturePersistence,
  createStoreSeededPosturePersistence,
  deriveManagedMode,
  LIVE_POSTURE_THREAD_ID,
  type PermissionModeSessionState,
} from "./build-posture"
// RFC-05 E4/E5 — the LIVE posture front-door builder: ONE authority backing the
// E3 mode adapter, the E4 control, and (via `authority`) the E5 question reader.
// The host composition root calls this at bootstrap in place of the mode-only
// `buildLivePermissionModeState` so `/posture`, the wire `session.posture.set`,
// and the `request_user_input` guard all share the SAME live authority.
export {
  buildLivePosture,
  type LivePosture,
  type LivePostureDurableStore,
} from "./build-posture-control"
// RFC-06 F1 — the single skill-runtime-authority builder. Surfaces construct the
// per-session skill authority HERE (no surface-local discovery scan + per-consumer
// disabled filter); it calls the REAL registry + admin-policy loaders and derives
// the three consistent projections at one unified revision.
export type { BuildSkillRuntimeAuthorityInput } from "./build-skills"
export { buildSkillRuntimeAuthority, SkillAdminPolicyLoadError } from "./build-skills"
export { decodeObjectiveSnapshot, normalizeObjectiveSnapshot } from "./restore"
export {
  type ComposeSessionSkillAuthorityInput,
  composeSessionSkillAuthority,
} from "./skill-inputs/compose-session-skill-authority"
export { defaultOrgConfigDir, resolveOrgConfigDir } from "./skill-inputs/org-config-dir"
export type {
  AttentionReader,
  BuildSessionAuthoritiesInput,
  SessionAuthorities,
} from "./types"
