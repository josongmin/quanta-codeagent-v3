/**
 * `@/runner/orchestrate` — surface-AGNOSTIC orchestration drivers.
 *
 * Public API:
 *   - `resolveResume(input)` + `isPathLikeToken` / `defaultUntitled` —
 *     surface-agnostic resume FSM. The CLI's resume helpers re-export
 *     from here.
 *   - `persistTurn(input)` — per-turn save plumbing. Both `state` (path-
 *     mode) and `idMeta` (id-mode) default OFF.
 *
 * Slice rules (RFC 3.1, enforced by biome):
 *   - May import `@/agent`, `@/llm`, `@/memory`, `@/observability`,
 *     `@/permission`, `@/session`, `@/shared`, `@/stream`, `@/tool`.
 *   - MUST NOT import from `apps/**` (any surface).
 *
 * Internal-only:
 *   - The legacy interactive/session compat owner now lives in
 *     `@/host/runtime/session-host`; runtime-SDK consumers go through
 *     `@/sdk/runtime`, while tests that pin old compat helpers import the
 *     concrete files directly.
 */

export type { PersistTurnInput } from "./persist-turn"
export { persistTurn } from "./persist-turn"
export type { ResolveResumeInput, ResumeResolution } from "./resume-fsm"
export { defaultUntitled, isPathLikeToken, resolveResume } from "./resume-fsm"
export type {
  SideChatContextInheritance,
  SideChatInput,
  SideChatResult,
} from "./side-chat"
export {
  buildSideChatHistory,
  buildSideChatRegistry,
  extractAnswerText,
  runSideChat,
  SIDE_CHAT_DEFAULT_READ_ONLY,
  SIDE_CHAT_FORBIDDEN,
  SIDE_CHAT_MAX_TURNS_CAP,
} from "./side-chat"
