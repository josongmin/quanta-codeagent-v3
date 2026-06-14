export const CHAT_SESSION_STATUS = {
    /** Thread is settled / waiting for the next prompt. Codex `task_complete`. */
    Idle: 1,
    /** A turn is running (or a turn is blocked on a human approval — still an
     *  ACTIVE turn from the editor's perspective, so the spinner stays up).
     *  Codex `task_started`. */
    InProgress: 2,
    /** The last turn failed. The editor renders this as an error badge. */
    Failed: 3,
};
/**
 * Map a session.v1 coarse {@link SessionStateView.status} to a chat status.
 * `awaiting_approval` is deliberately InProgress — the turn has not ended; the
 * editor must keep showing activity (a hidden approval modal is not "idle").
 */
export const statusForStateView = (status) => {
    switch (status) {
        case "running":
        case "awaiting_approval":
            return CHAT_SESSION_STATUS.InProgress;
        case "failed":
            return CHAT_SESSION_STATUS.Failed;
        case "idle":
        case "closed":
            return CHAT_SESSION_STATUS.Idle;
        default: {
            // Exhaustiveness guard: a new SessionStateView status must be classified
            // here explicitly rather than silently defaulting to Idle (which would be
            // a UI-lie — e.g. a future "paused" rendered as settled).
            const _exhaustive = status;
            return CHAT_SESSION_STATUS.Idle;
        }
    }
};
