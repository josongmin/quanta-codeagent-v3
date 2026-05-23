/**
 * `@/runner/orchestrate` — surface-AGNOSTIC orchestration drivers.
 *
 * Public API:
 *   - `runOnce(input)` — execute a single agent turn end-to-end (history
 *     append → runAgent → persist → optional onTurnEnd → mcp shutdown).
 *     Reusable from any surface; the CLI argv-prompt branch delegates here.
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
 * Interactive loop: `runInteractive(input)` drives the same per-turn atom
 * as `runOnce` in a loop, sourcing each prompt from a `PromptSource` port.
 * Surface-specific UI primitives (raw-line-reader, status bar, Esc-Esc,
 * shell-stream painter) stay in `apps/cli/repl.ts` — the surface wraps them
 * into a `PromptSource` adapter and injects it here.
 */

export type { PersistTurnInput } from "./persist-turn"
export { persistTurn } from "./persist-turn"
export type { PromptPayload, PromptSource } from "./prompt-source"
export { normalizePromptPayload } from "./prompt-source"
export type { ResolveResumeInput, ResumeResolution } from "./resume-fsm"
export { defaultUntitled, isPathLikeToken, resolveResume } from "./resume-fsm"
export type { RunInteractiveInput } from "./run-interactive"
export { runInteractive } from "./run-interactive"
export type { OrchestrateDeps, RunOnceInput, RunOnceResult } from "./run-once"
export { runOnce } from "./run-once"
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
