/**
 * RFC-01 A1 — user-question domain types (`@/session/user-question`).
 *
 * The pending-question authority is the TRUTH for "a real question is awaiting
 * an operator answer." It is NOT a task status (the closed 4-valued
 * `TaskStatus` in `@/subagent` stays untouched) and NOT a follow-up park event.
 *
 * SLICE ISOLATION: this module imports no `@/subagent`, `@/agent`, app, host, or
 * runner value — the task/question JOIN lives in `@/agent/attention` (RFC-01 A3),
 * the repository's legal cross-slice bridge. Session identity is supplied by the
 * protocol/host routing outside the domain record (blueprint §5), so no `sessionId`
 * is duplicated onto every owner arm.
 */

/** Who a question belongs to. Only the `task` arm joins the subagent attention
 *  list; a `root` question stays a session-level question. No synthetic root
 *  task and no ancestry-derived root id is ever minted (blueprint §5 / §10). */
export type QuestionOwner =
  | { readonly kind: "root" }
  | { readonly kind: "task"; readonly taskId: string }

/** A request handed to {@link UserQuestionBroker.request}. The raw `prompt` is
 *  delivered in-process only; the projection ({@link PendingQuestion}) carries a
 *  bounded + secret-scrubbed preview instead (blueprint §6). */
export interface QuestionRequest {
  readonly owner: QuestionOwner
  readonly prompt: string
  /** OPTIONAL fixed-choice list a surface may render as buttons. */
  readonly choices?: readonly string[]
  /** OPTIONAL hint that the answer may span multiple lines. */
  readonly multiline?: boolean
}

/** The operator's answer payload relayed back to the awaiting caller. */
export interface QuestionAnswer {
  readonly text: string
}

/** Why a pending question was cancelled rather than answered/declined.
 *  CLOSED union — a new reason is a compile error at every exhaustive consumer. */
export type QuestionCancelReason = "teardown" | "aborted" | "superseded"

/** CLOSED outcome the awaiting `request()` Promise settles with. The agent
 *  tool-adapter (A3) maps this to the tool-facing `UserInputOutcome`
 *  (`@/tool` `request_user_input`). */
export type QuestionOutcome =
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "declined" }
  | { readonly kind: "cancelled"; readonly reason: QuestionCancelReason }

/** Immutable projection of one pending question. Carries a bounded + secret-
 *  scrubbed `preview` ONLY — never the raw prompt or answer (blueprint §6). The
 *  opaque `requestId` is the ONLY response-correlation key. */
export interface PendingQuestion {
  readonly requestId: string
  readonly owner: QuestionOwner
  readonly askedAt: number
  readonly preview: string
}

/** Typed result of an answer/decline/cancel transition.
 *  - `stale`  ⇒ the caller's `expectedRevision` no longer matches the domain
 *    revision (a concurrent publish/settle advanced it); re-read and retry.
 *  - `unknown` ⇒ no such pending id (never existed, or already settled/removed).
 *    A settled request is REMOVED, so a double-answer's second call is `unknown`. */
export type QuestionResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: "unknown" | "stale"; readonly revision: number }
