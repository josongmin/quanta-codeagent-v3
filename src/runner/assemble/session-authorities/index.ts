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
export { decodeObjectiveSnapshot } from "./restore"
export type {
  AttentionReader,
  BuildSessionAuthoritiesInput,
  SessionAuthorities,
} from "./types"
