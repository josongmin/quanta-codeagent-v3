/**
 * `@/attention` — RFC-01 pure attention-navigation leaf barrel.
 *
 * Consumed by the A3 bridge (`@/agent/attention`), which derives the
 * `AttentionAgent[]` snapshot from the live `TaskRegistry` + `UserQuestionBroker`
 * and calls {@link nextNeedingAttention}. This slice imports only `@/shared`.
 */

export type { AttentionAgent, PendingQuestionView } from "./model"
export { nextNeedingAttention } from "./resolver"
