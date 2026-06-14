/**
 * T07 — status mapping: session.v1 lifecycle → VS Code `ChatSessionStatus`.
 *
 * PURE. No `vscode` import (the core-decoupling invariant — see
 * `core-no-vscode-leak-ratchet.test.ts`). The numeric values MIRROR the Codex
 * IDE corpus observation (`task_started` → 2 = in-progress, `task_complete` →
 * 1 = idle); the VS Code `chatSessionsProvider` proposal is UNSTABLE and its
 * enum values are version-dependent, so the provider shell
 * (`provider.ts`) is responsible for re-mapping these to the concrete
 * `vscode.ChatSessionStatus` of the VS Code build it targets. Keeping the
 * mapping here means the adapter never imports the proposed enum.
 */
import type { SessionStateView } from "@/protocol/session"

export const CHAT_SESSION_STATUS = {
  /** Thread is settled / waiting for the next prompt. Codex `task_complete`. */
  Idle: 1,
  /** A turn is running (or a turn is blocked on a human approval — still an
   *  ACTIVE turn from the editor's perspective, so the spinner stays up).
   *  Codex `task_started`. */
  InProgress: 2,
  /** The last turn failed. The editor renders this as an error badge. */
  Failed: 3,
} as const

export type ChatSessionStatusValue = (typeof CHAT_SESSION_STATUS)[keyof typeof CHAT_SESSION_STATUS]

/**
 * Map a session.v1 coarse {@link SessionStateView.status} to a chat status.
 * `awaiting_approval` is deliberately InProgress — the turn has not ended; the
 * editor must keep showing activity (a hidden approval modal is not "idle").
 */
export const statusForStateView = (status: SessionStateView["status"]): ChatSessionStatusValue => {
  switch (status) {
    case "running":
    case "awaiting_approval":
      return CHAT_SESSION_STATUS.InProgress
    case "failed":
      return CHAT_SESSION_STATUS.Failed
    case "idle":
    case "closed":
      return CHAT_SESSION_STATUS.Idle
    default: {
      // Exhaustiveness guard: a new SessionStateView status must be classified
      // here explicitly rather than silently defaulting to Idle (which would be
      // a UI-lie — e.g. a future "paused" rendered as settled).
      const _exhaustive: never = status
      return CHAT_SESSION_STATUS.Idle
    }
  }
}
