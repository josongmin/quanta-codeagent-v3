/**
 * ADR-0221 — `::git-*` 5-directive emit protocol barrel.
 *
 * Phase-guarded sibling to ADR-0220 (wire/serdes at `@/agent/git-directives`).
 * Codex behavioral protocol: directives may be emitted ONLY in the
 * `final-answer` phase, after a confirmed-successful mutating git operation.
 * Default-OFF (`noopEmitter`) so existing call sites stay byte-identical
 * when no host opts in.
 *
 * Slice isolation: imports only `@/shared`. Does NOT touch `@/tool`,
 * `@/llm`, `@/mcp`, `@/permission`, or `@/agent`. Caller-side wiring lives
 * in the tool slices (1-line emit() per success path), not here.
 */

export { type DirectiveSink, defaultEmitter, noopEmitter } from "./emitter"
export { parse } from "./parser"
export { checkPhase } from "./phase-guard"
export type { DirectiveEmitterPort, EmitContext } from "./port"
export { serialize } from "./serializer"
export {
  buildGitDirectiveCollector,
  type GitDirectiveCollector,
  type GitDirectiveCollectorOptions,
  noopCollector,
} from "./turn-collector"
export {
  type EmitError,
  type EmitPhase,
  GIT_DIRECTIVE_KINDS,
  type GitDirective,
  type GitDirectiveKind,
} from "./types"
export { validateDirective } from "./validate"
