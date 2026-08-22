/**
 * RFC-01 A3 — user-input PRODUCER adapter (`@/agent/user-question`).
 *
 * Adapts the tool-facing {@link UserInputRequester} (`@/tool`
 * `request_user_input`) THROUGH the {@link UserQuestionBroker}
 * (`@/session/user-question`): the broker becomes the single pending-question
 * authority whose published record A2's `AttentionReader` joins into a fleet
 * row. `@/agent` is the repository's legal cross-slice bridge (blueprint §5), so
 * this join of the tool seam and the session broker lives here.
 *
 * Flow (blueprint §5 / RFC-01 A3):
 *   request_user_input -> this adapter binds the owner + publishes pending
 *   -> broker.request awaits -> [A4 CLI `/attention answer`] -> broker.answer
 *   -> the original tool call resolves and the pending disappears.
 *
 * The broker SUPERSEDES the legacy `AgentConfig.userInputPort` when present
 * (gate ON): the CLI inline surface is re-adapted to `broker.answer` in A4.
 * When no broker is wired (gate OFF), the dispatch seam keeps using the legacy
 * port verbatim, so the OFF path stays byte-identical.
 *
 * CANCELLATION: the tool's turn `signal` is bridged to `broker.cancel(...,
 * "aborted", ...)` in a `finally`, so an aborted turn never leaks a pending
 * waiter. Teardown (`broker.cancelAll`) is the broker's own lifecycle.
 */

import type {
  QuestionOutcome,
  QuestionOwner,
  QuestionRequest,
  UserQuestionBroker,
} from "@/session/user-question"
import type { UserInputOutcome, UserInputRequester } from "@/tool"

/** Map the broker's CLOSED {@link QuestionOutcome} onto the tool-facing CLOSED
 *  {@link UserInputOutcome}. Both `declined` and `cancelled` collapse to the
 *  tool's single `cancelled` arm (the tool surfaces both as a typed
 *  `user_cancelled` rejection). A new outcome arm is a compile error here. */
const toUserInputOutcome = (outcome: QuestionOutcome): UserInputOutcome => {
  switch (outcome.kind) {
    case "answered":
      return { decision: "answer", text: outcome.text }
    case "declined":
      return { decision: "cancelled" }
    case "cancelled":
      return { decision: "cancelled" }
    default: {
      // Closed-union exhaustiveness guard — no heuristic fallthrough.
      const _never: never = outcome
      void _never
      return { decision: "cancelled" }
    }
  }
}

/**
 * Build a {@link UserInputRequester} that routes a question through the broker,
 * bound to `owner`. `signal` (the tool's turn signal) cancels the pending on
 * abort.
 */
export const bindBrokerUserInputPort = (
  broker: UserQuestionBroker,
  owner: QuestionOwner,
  signal?: AbortSignal,
): UserInputRequester => {
  return async (req) => {
    // Recover the opaque requestId for cancellation. The broker publishes
    // SYNCHRONOUSLY inside `request()`, and this block runs atomically (no
    // `await` between the snapshot and the diff), so the newly-published id is
    // deterministic even when sibling agents share the broker.
    const before = new Set(broker.listPending().map((p) => p.requestId))
    const request: QuestionRequest = {
      owner,
      prompt: req.prompt,
      ...(req.choices !== undefined ? { choices: req.choices } : {}),
      ...(req.multiline !== undefined ? { multiline: req.multiline } : {}),
    }
    const outcomeP = broker.request(request)
    const mine = broker.listPending().find((p) => !before.has(p.requestId))
    const requestId = mine?.requestId

    const onAbort = (): void => {
      // CAS against the live revision read at cancel time (synchronous) so a
      // concurrent settle wins cleanly; an already-settled id reports `unknown`
      // and is a harmless no-op.
      if (requestId !== undefined) broker.cancel(requestId, "aborted", broker.revision())
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
    try {
      return toUserInputOutcome(await outcomeP)
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  }
}
