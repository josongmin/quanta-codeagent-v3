/**
 * Queued follow-ups (ADR-0037, Cluster D Feature 3).
 *
 * Codex `codex-follow-up-queue-pattern` absorption. Pattern:
 *
 *   - The user can submit a follow-up message while the previous turn is
 *     still running. The follow-up is NOT delivered to the model until the
 *     run leaves its `pausedReason` state.
 *   - Each thread has its own queue (FIFO, isolated). Multi-thread runs
 *     never bleed follow-ups across threads.
 *   - Queue state is serializable for restart resume (`toSnapshot`/
 *     `fromSnapshot`).
 *
 * The UI surface that surfaces the queued count to the user is out of scope
 * for this cluster — see ADR-0037 §한계.
 */
/** Construct a {@link ThreadId} from a raw string. */
export const threadId = (s) => s;
/** All 10 reasons as a readonly array — used by the enum-coverage test. */
export const ALL_PAUSED_REASONS = Object.freeze([
    "model_streaming",
    "tool_running",
    "awaiting_approval",
    "awaiting_user",
    "network_retry",
    "compaction_in_progress",
    "review_in_progress",
    "hand_off_in_progress",
    "mid_turn_steer_in_flight",
    "unknown_blocking",
]);
/** Documented condition for each {@link PausedReason}. The
 *  `paused-reason-enum.test.ts` test asserts coverage. */
export const PAUSED_REASON_DOCS = Object.freeze({
    model_streaming: "LLM stream is open and tokens are arriving.",
    tool_running: "Tool call is executing (long bash, network read, etc.).",
    awaiting_approval: "HITL always-confirm gate is waiting on the user.",
    awaiting_user: "Agent asked a clarifying question and stopped.",
    network_retry: "Provider 429/5xx backoff is in progress.",
    compaction_in_progress: "Compaction turn is rewriting the conversation.",
    review_in_progress: "Review-mode turn is in flight.",
    hand_off_in_progress: "HITL hand-off-required tier fired; terminating.",
    mid_turn_steer_in_flight: "A steer was injected and the model has not yet consumed it.",
    unknown_blocking: "Caller-supplied blocking reason that is not yet named.",
});
/** Per-thread FIFO queue + multi-thread isolation. In-memory; persistence
 *  is via {@link toSnapshot}/{@link fromSnapshot}. */
export class FollowUpQueue {
    map = new Map();
    /** Deterministic id seed — incremented per `enqueue` so ids are stable
     *  across snapshot round-trips when the queue is re-hydrated with the
     *  same submission order. */
    nextSeq = 0;
    /** Build a deterministic follow-up id from the seq + threadId. */
    static makeId(threadId, seq) {
        return `fu-${threadId}-${seq.toString(36).padStart(6, "0")}`;
    }
    enqueue(threadId, partial) {
        const seq = this.nextSeq++;
        const fu = {
            ...partial,
            id: FollowUpQueue.makeId(threadId, seq),
        };
        const list = this.map.get(threadId);
        if (list === undefined)
            this.map.set(threadId, [fu]);
        else
            list.push(fu);
        return fu;
    }
    peek(threadId) {
        const list = this.map.get(threadId);
        if (list === undefined || list.length === 0)
            return null;
        return list[0] ?? null;
    }
    /** Pop the head iff `pausedReason === null`. Returns the ready follow-up
     *  AND a defensive copy of the remaining entries for the caller's
     *  inspection. Returns `null` if the thread has no queue, is empty, or
     *  the thread is still paused. */
    popReady(threadId, pausedReason) {
        if (pausedReason !== null)
            return null;
        const list = this.map.get(threadId);
        if (list === undefined || list.length === 0)
            return null;
        const ready = list.shift();
        if (ready === undefined)
            return null;
        return { ready, remaining: [...list] };
    }
    /** Drain ALL entries for a thread (used at thread close to surface
     *  unprocessed follow-ups to the operator). */
    drain(threadId) {
        const list = this.map.get(threadId);
        if (list === undefined)
            return [];
        this.map.delete(threadId);
        return list;
    }
    /** Number of queued follow-ups across all threads (for tests / metrics). */
    size() {
        let n = 0;
        for (const list of this.map.values())
            n += list.length;
        return n;
    }
    /** Per-thread count (for tests / metrics). */
    sizeFor(threadId) {
        return this.map.get(threadId)?.length ?? 0;
    }
    /** Active thread ids — order is insertion order. */
    threads() {
        return [...this.map.keys()];
    }
    /** Serialize for persistence. Snapshot is JSON-safe. */
    toSnapshot() {
        const threads = [...this.map.entries()].map(([tid, entries]) => ({
            threadId: tid,
            entries: [...entries],
        }));
        return { version: 1, threads };
    }
    /** Reconstruct a queue from a snapshot. The seq counter is reset to one
     *  past the maximum existing seq so post-restore enqueues never collide
     *  with restored ids. */
    static fromSnapshot(snapshot) {
        if (snapshot.version !== 1) {
            throw new Error(`Unsupported FollowUpQueueSnapshot version: ${String(snapshot.version)}`);
        }
        const q = new FollowUpQueue();
        let maxSeq = -1;
        for (const t of snapshot.threads) {
            const tid = t.threadId;
            q.map.set(tid, [...t.entries]);
            for (const e of t.entries) {
                const m = /^fu-.+-([0-9a-z]+)$/.exec(e.id);
                if (m !== null) {
                    const seq = Number.parseInt(m[1] ?? "0", 36);
                    if (Number.isFinite(seq) && seq > maxSeq)
                        maxSeq = seq;
                }
            }
        }
        q.nextSeq = maxSeq + 1;
        return q;
    }
}
