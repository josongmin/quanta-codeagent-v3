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

import type { Id } from "@/shared"

/** Turn id alias (raw string). Defined locally because user's ADR-0030
 *  steering module ({@link ./steering}) uses `string` directly rather than a
 *  branded type; this alias keeps the queue's intent explicit without
 *  pulling in a heavier dependency. */
type TurnId = string

/** Brand for follow-up ids — deterministic per submission ordering. */
export type FollowUpId = Id<"FollowUpId">

/** Brand for thread ids — `Id<"ThreadId">` to keep thread scope distinct
 *  from session/turn scope. */
export type ThreadId = Id<"ThreadId">

/** Construct a {@link ThreadId} from a raw string. */
export const threadId = (s: string): ThreadId => s as ThreadId

/** A single queued follow-up entry. `submittedTurnId` is `null` if the
 *  follow-up was submitted between turns (queue empty / first message). */
export interface FollowUp {
  readonly id: FollowUpId
  readonly content: string
  readonly submittedAt: number
  readonly submittedTurnId: TurnId | null
  readonly metadata: Readonly<Record<string, string>>
}

/** 10 explicit pause reasons. Each MUST have a documented set of conditions
 *  in v3 where it would be the active reason. Codex's vocabulary plus our
 *  v3-specific reasons (mid-turn-steer-in-flight, hand-off-in-progress).
 *
 *   - `model_streaming`: an LLM stream is open and tokens are arriving.
 *     Follow-up is queued because injecting a user message mid-stream would
 *     desync the provider's `assistant`/`tool_use` ordering.
 *   - `tool_running`: a tool call is in flight (e.g. `bash` long command).
 *     Follow-up is queued until the tool result is appended.
 *   - `awaiting_approval`: HITL `always-confirm` gate is waiting for the
 *     user to approve or deny — the user IS already mid-interaction; a new
 *     follow-up would race the prompt.
 *   - `awaiting_user`: agent finished and asked a question (clarifying
 *     ambiguity). Follow-ups go into the queue so they aren't lost between
 *     the question and the answer being typed.
 *   - `network_retry`: provider 429/5xx backoff is in progress; queue the
 *     follow-up until the retry resolves.
 *   - `compaction_in_progress`: a compaction turn is running. Follow-ups
 *     wait so they apply to the post-compaction message list.
 *   - `review_in_progress`: a review-mode turn is running. Follow-ups wait
 *     so review evidence isn't polluted by mid-flight user input.
 *   - `hand_off_in_progress`: HITL `hand-off-required` tier fired — the
 *     agent is terminating; follow-ups queue but will be drained at thread
 *     close so the operator can see them.
 *   - `mid_turn_steer_in_flight`: a steer (ADR-0030) has been injected and
 *     the next model step has not yet consumed it; new follow-ups queue so
 *     they don't pre-empt the steer.
 *   - `unknown_blocking`: any other caller-supplied non-null reason. Strict
 *     mode for callers: ALWAYS prefer a named reason; this exists so the
 *     queue contract doesn't break if a new reason ships before the enum is
 *     extended. The test suite asserts no production code path uses it.
 */
export type PausedReason =
  | "model_streaming"
  | "tool_running"
  | "awaiting_approval"
  | "awaiting_user"
  | "network_retry"
  | "compaction_in_progress"
  | "review_in_progress"
  | "hand_off_in_progress"
  | "mid_turn_steer_in_flight"
  | "unknown_blocking"

/** All 10 reasons as a readonly array — used by the enum-coverage test. */
export const ALL_PAUSED_REASONS: readonly PausedReason[] = Object.freeze([
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
] as const)

/** Documented condition for each {@link PausedReason}. The
 *  `paused-reason-enum.test.ts` test asserts coverage. */
export const PAUSED_REASON_DOCS: Readonly<Record<PausedReason, string>> = Object.freeze({
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
})

/** Serializable snapshot for restart-resume. */
export interface FollowUpQueueSnapshot {
  readonly version: 1
  readonly threads: ReadonlyArray<{
    readonly threadId: string
    readonly entries: readonly FollowUp[]
  }>
}

/** Per-thread FIFO queue + multi-thread isolation. In-memory; persistence
 *  is via {@link toSnapshot}/{@link fromSnapshot}. */
export class FollowUpQueue {
  private readonly map = new Map<ThreadId, FollowUp[]>()
  /** Deterministic id seed — incremented per `enqueue` so ids are stable
   *  across snapshot round-trips when the queue is re-hydrated with the
   *  same submission order. */
  private nextSeq = 0

  /** Build a deterministic follow-up id from the seq + threadId. */
  static makeId(threadId: ThreadId, seq: number): FollowUpId {
    return `fu-${threadId}-${seq.toString(36).padStart(6, "0")}` as FollowUpId
  }

  enqueue(threadId: ThreadId, partial: Omit<FollowUp, "id">): FollowUp {
    const seq = this.nextSeq++
    const fu: FollowUp = {
      ...partial,
      id: FollowUpQueue.makeId(threadId, seq),
    }
    const list = this.map.get(threadId)
    if (list === undefined) this.map.set(threadId, [fu])
    else list.push(fu)
    return fu
  }

  peek(threadId: ThreadId): FollowUp | null {
    const list = this.map.get(threadId)
    if (list === undefined || list.length === 0) return null
    return list[0] ?? null
  }

  /** Pop the head iff `pausedReason === null`. Returns the ready follow-up
   *  AND a defensive copy of the remaining entries for the caller's
   *  inspection. Returns `null` if the thread has no queue, is empty, or
   *  the thread is still paused. */
  popReady(
    threadId: ThreadId,
    pausedReason: PausedReason | null,
  ): { ready: FollowUp; remaining: FollowUp[] } | null {
    if (pausedReason !== null) return null
    const list = this.map.get(threadId)
    if (list === undefined || list.length === 0) return null
    const ready = list.shift()
    if (ready === undefined) return null
    return { ready, remaining: [...list] }
  }

  /** Drain ALL entries for a thread (used at thread close to surface
   *  unprocessed follow-ups to the operator). */
  drain(threadId: ThreadId): FollowUp[] {
    const list = this.map.get(threadId)
    if (list === undefined) return []
    this.map.delete(threadId)
    return list
  }

  /** Number of queued follow-ups across all threads (for tests / metrics). */
  size(): number {
    let n = 0
    for (const list of this.map.values()) n += list.length
    return n
  }

  /** Per-thread count (for tests / metrics). */
  sizeFor(threadId: ThreadId): number {
    return this.map.get(threadId)?.length ?? 0
  }

  /** Active thread ids — order is insertion order. */
  threads(): ThreadId[] {
    return [...this.map.keys()]
  }

  /** Serialize for persistence. Snapshot is JSON-safe. */
  toSnapshot(): FollowUpQueueSnapshot {
    const threads = [...this.map.entries()].map(([tid, entries]) => ({
      threadId: tid as string,
      entries: [...entries],
    }))
    return { version: 1, threads }
  }

  /** Reconstruct a queue from a snapshot. The seq counter is reset to one
   *  past the maximum existing seq so post-restore enqueues never collide
   *  with restored ids. */
  static fromSnapshot(snapshot: FollowUpQueueSnapshot): FollowUpQueue {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported FollowUpQueueSnapshot version: ${String(snapshot.version)}`)
    }
    const q = new FollowUpQueue()
    let maxSeq = -1
    for (const t of snapshot.threads) {
      const tid = t.threadId as ThreadId
      q.map.set(tid, [...t.entries])
      for (const e of t.entries) {
        const m = /^fu-.+-([0-9a-z]+)$/.exec(e.id)
        if (m !== null) {
          const seq = Number.parseInt(m[1] ?? "0", 36)
          if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
        }
      }
    }
    q.nextSeq = maxSeq + 1
    return q
  }
}
