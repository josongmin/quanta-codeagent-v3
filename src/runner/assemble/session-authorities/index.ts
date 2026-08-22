/**
 * `@/runner/assemble/session-authorities` — RFC-01 A2 session-authority graph
 * barrel. The one multi-domain constructor seam (blueprint §3); A2 seeds it with
 * the task/question/attention arms, later packets extend it.
 */

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
  deriveManagedMode,
  LIVE_POSTURE_THREAD_ID,
  type PermissionModeSessionState,
} from "./build-posture"
// RFC-06 F1 — the single skill-runtime-authority builder. Surfaces construct the
// per-session skill authority HERE (no surface-local discovery scan + per-consumer
// disabled filter); it calls the REAL registry + admin-policy loaders and derives
// the three consistent projections at one unified revision.
export type { BuildSkillRuntimeAuthorityInput } from "./build-skills"
export { buildSkillRuntimeAuthority } from "./build-skills"
export { decodeObjectiveSnapshot } from "./restore"
export type {
  AttentionReader,
  BuildSessionAuthoritiesInput,
  SessionAuthorities,
} from "./types"
