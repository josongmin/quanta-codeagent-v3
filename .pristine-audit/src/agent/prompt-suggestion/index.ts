/**
 * Prompt-suggestion slice barrel (ADR-0467).
 *
 * Suggest what the user might naturally type next, gated behind a rich quality
 * REJECT GATE (the crown jewel — a pure closed-enum filter reusable anywhere a
 * model-produced "next prompt" needs vetting).
 *
 * Plane-clean: this slice imports ONLY `@/shared`. The model call is the
 * injected {@link SuggestFn} (port inversion); the surface state is the typed
 * {@link AppStateView}. Zero `@/llm` / `@/tool` / `@/permission` / `@/mcp`.
 *
 * Default-OFF: nothing in `@/apps` imports this barrel today. The orchestrator
 * is dead until a surface wires the `SuggestFn` adapter AND sets
 * `QUANTA_ENABLE_PROMPT_SUGGESTION=1`. Both are integration steps the human
 * applies (see the ADR's integrationTodos).
 */

export {
  PROMPT_SUGGESTION_ENV,
  type PromptSuggestionRequest,
  promptSuggestionEnabled,
  runPromptSuggestion,
  SUGGESTION_MODE_SYSTEM_PROMPT,
} from "./orchestrator"
export { describeReason, rejectGate } from "./reject-gate"
export { sanitizeSuggestion } from "./sanitize"
export { suppressionReason } from "./suppression"
export {
  type AppStateView,
  REJECT_REASONS,
  type RejectReason,
  type RejectVerdict,
  SHORT_COMMAND_WHITELIST,
  SUGGESTION_LIMITS,
  type SuggestFn,
  type SuggestionOutcome,
  type SuppressReason,
} from "./types"
