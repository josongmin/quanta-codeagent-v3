/**
 * `@/session/user-question` — RFC-01 A1 pending-question authority barrel.
 */

export type { UserQuestionBroker, UserQuestionBrokerDeps } from "./broker"
export { createUserQuestionBroker } from "./broker"
export type {
  PendingQuestion,
  QuestionAnswer,
  QuestionCancelReason,
  QuestionOutcome,
  QuestionOwner,
  QuestionRequest,
  QuestionResult,
} from "./types"
