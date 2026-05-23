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
 * Partial-adoption note: `runInteractive` (the REPL-like loop with status
 * bar + Esc-Esc cancel + raw-line-reader) is deliberately NOT in this slice
 * yet — those primitives are surface-specific and stay in `apps/cli/repl.ts`.
 * The first Web/Tauri use case is one-shot REST/IPC, which this `runOnce`
 * covers. The interactive extraction is a follow-up once the surface seams
 * (`promptSource` async-iterable, `confirm` port, status sink) are agreed.
 */

export type { PersistTurnInput } from "./persist-turn"
export { persistTurn } from "./persist-turn"
export type { ResolveResumeInput, ResumeResolution } from "./resume-fsm"
export { defaultUntitled, isPathLikeToken, resolveResume } from "./resume-fsm"
export type { OrchestrateDeps, RunOnceInput, RunOnceResult } from "./run-once"
export { runOnce } from "./run-once"
