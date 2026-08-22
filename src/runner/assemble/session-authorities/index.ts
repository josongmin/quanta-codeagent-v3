/**
 * `@/runner/assemble/session-authorities` — RFC-01 A2 session-authority graph
 * barrel. The one multi-domain constructor seam (blueprint §3); A2 seeds it with
 * the task/question/attention arms, later packets extend it.
 */

export { buildSessionAuthorities } from "./build"
export type {
  AttentionReader,
  BuildSessionAuthoritiesInput,
  SessionAuthorities,
} from "./types"
