/**
 * Side-conversation seam (ADR-0049) — barrel.
 *
 * The seam was split (#10) into three cohesive modules:
 *   - `./prompt`   — byte-identical Codex base + delimiter + quanta addendum.
 *   - `./run`      — executor, options/result types, error classes, token est.
 *   - `./dispatch` — external request/response + resolver indirection.
 *
 * This barrel re-exports the SAME symbols the former `side-conversation.ts`
 * single file exposed, so `@/agent` and every `./side-conversation` /
 * `@/agent/side-conversation` consumer imports an unchanged surface.
 */
export { dispatchSideConversation, } from "./dispatch";
export { SIDE_CONVERSATION_PROMPT, SIDE_CONVERSATION_PROMPT_BASE, SIDE_CONVERSATION_PROMPT_DELIMITER, SIDE_CONVERSATION_QUANTA_ADDENDUM, } from "./prompt";
export { assertSideConversationEffort, DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET, DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET, estimateSideConversationTokens, filterSideConversationTools, runSideConversation, SIDE_CONVERSATION_TOOL_NAMES, SideConversationAbortedError, SideConversationBudgetError, SideConversationEffortError, SideConversationToolError, } from "./run";
