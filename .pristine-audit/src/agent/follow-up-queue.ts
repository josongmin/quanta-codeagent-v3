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

import { type Id, isRecord } from "@/shared"

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

export interface FollowUpQueueSnapshot {
  readonly version: 2
  readonly maxPerThread: number
  readonly threads: ReadonlyArray<{
    readonly threadId: string
    readonly entries: readonly FollowUp[]
  }>
}

export interface FollowUpQueueOptions {
  readonly maxPerThread?: number
}

type ThreadQueueState = {
  entries: FollowUp[]
  head: number
}

export const DEFAULT_FOLLOW_UP_QUEUE_MAX_PER_THREAD = 32

const normalizeMaxPerThread = (value: number | undefined): number => {
  const normalized = Math.floor(value ?? DEFAULT_FOLLOW_UP_QUEUE_MAX_PER_THREAD)
  return normalized >= 1 ? normalized : 1
}

const parseSeq = (id: string): number => {
  const m = /^fu-.+-([0-9a-z]+)$/.exec(id)
  if (m === null) return -1
  const seq = Number.parseInt(m[1] ?? "0", 36)
  return Number.isFinite(seq) ? seq : -1
}

const assertFollowUp = (value: unknown): FollowUp => {
  if (!isRecord(value)) throw new Error("Malformed FollowUpQueueSnapshot entry")
  if (typeof value.id !== "string") throw new Error("Malformed FollowUpQueueSnapshot entry")
  if (typeof value.content !== "string") throw new Error("Malformed FollowUpQueueSnapshot entry")
  if (typeof value.submittedAt !== "number")
    throw new Error("Malformed FollowUpQueueSnapshot entry")
  if (value.submittedTurnId !== null && typeof value.submittedTurnId !== "string") {
    throw new Error("Malformed FollowUpQueueSnapshot entry")
  }
  if (!isRecord(value.metadata)) throw new Error("Malformed FollowUpQueueSnapshot entry")
  const metadata: Record<string, string> = {}
  for (const [k, v] of Object.entries(value.metadata)) {
    if (typeof k !== "string" || typeof v !== "string") {
      throw new Error("Malformed FollowUpQueueSnapshot entry")
    }
    metadata[k] = v
  }
  // Reconstruct in the SAME field order as `enqueue` (`{ ...partial, id }`,
  // i.e. id LAST). JSON.stringify emits keys in insertion order, so divergent
  // construction order here would make `toSnapshot` non-idempotent across a
  // restore round-trip (id would float to the front). Keep id last.
  return {
    content: value.content,
    submittedAt: value.submittedAt,
    submittedTurnId: value.submittedTurnId as TurnId | null,
    metadata,
    id: value.id as FollowUpId,
  }
}

/** Per-thread FIFO queue + multi-thread isolation. In-memory; persistence
 *  is via {@link toSnapshot}/{@link fromSnapshot}. */
export class FollowUpQueue {
  private readonly map = new Map<ThreadId, ThreadQueueState>()
  private maxPerThread: number
  /** Deterministic id seed — incremented per `enqueue` so ids are stable
   *  across snapshot round-trips when the queue is re-hydrated with the
   *  same submission order. */
  private nextSeq = 0

  constructor(opts?: FollowUpQueueOptions) {
    this.maxPerThread = normalizeMaxPerThread(opts?.maxPerThread)
  }

  /** Build a deterministic follow-up id from the seq + threadId. */
  static makeId(threadId: ThreadId, seq: number): FollowUpId {
    return `fu-${threadId}-${seq.toString(36).padStart(6, "0")}` as FollowUpId
  }

  private static liveSize(state: ThreadQueueState): number {
    return state.entries.length - state.head
  }

  private static liveEntries(state: ThreadQueueState): FollowUp[] {
    return state.entries.slice(state.head)
  }

  private ensureThread(threadId: ThreadId): ThreadQueueState {
    const existing = this.map.get(threadId)
    if (existing !== undefined) return existing
    const created: ThreadQueueState = { entries: [], head: 0 }
    this.map.set(threadId, created)
    return created
  }

  private compactThread(threadId: ThreadId, state: ThreadQueueState): void {
    if (state.head === 0) return
    if (state.head >= state.entries.length) {
      this.map.delete(threadId)
      return
    }
    if (state.head >= state.entries.length / 2) {
      state.entries = state.entries.slice(state.head)
      state.head = 0
    }
  }

  enqueue(threadId: ThreadId, partial: Omit<FollowUp, "id">): FollowUp {
    const seq = this.nextSeq++
    const fu: FollowUp = {
      ...partial,
      id: FollowUpQueue.makeId(threadId, seq),
    }
    const state = this.ensureThread(threadId)
    state.entries.push(fu)
    const overflow = FollowUpQueue.liveSize(state) - this.maxPerThread
    if (overflow > 0) {
      state.head += overflow
      this.compactThread(threadId, state)
    }
    return fu
  }

  peek(threadId: ThreadId): FollowUp | null {
    const state = this.map.get(threadId)
    if (state === undefined) return null
    return state.entries[state.head] ?? null
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
    const state = this.map.get(threadId)
    if (state === undefined) return null
    const ready = state.entries[state.head]
    if (ready === undefined) return null
    state.head += 1
    const remaining = FollowUpQueue.liveEntries(state)
    this.compactThread(threadId, state)
    return { ready, remaining }
  }

  /** Drain ALL entries for a thread (used at thread close to surface
   *  unprocessed follow-ups to the operator). */
  drain(threadId: ThreadId): FollowUp[] {
    const state = this.map.get(threadId)
    if (state === undefined) return []
    this.map.delete(threadId)
    return FollowUpQueue.liveEntries(state)
  }

  /** Number of queued follow-ups across all threads (for tests / metrics). */
  size(): number {
    let n = 0
    for (const state of this.map.values()) n += FollowUpQueue.liveSize(state)
    return n
  }

  /** Per-thread count (for tests / metrics). */
  sizeFor(threadId: ThreadId): number {
    const state = this.map.get(threadId)
    return state === undefined ? 0 : FollowUpQueue.liveSize(state)
  }

  /** Active thread ids — order is insertion order. */
  threads(): ThreadId[] {
    return [...this.map.keys()]
  }

  /** Serialize for persistence. Snapshot is JSON-safe. */
  toSnapshot(): FollowUpQueueSnapshot {
    const threads = [...this.map.entries()].map(([tid, state]) => ({
      threadId: tid as string,
      entries: FollowUpQueue.liveEntries(state),
    }))
    return { version: 2, maxPerThread: this.maxPerThread, threads }
  }

  /** Replace the queue with a snapshot. Version 1 snapshots are restored
   *  with the queue's current cap because the legacy shape did not persist
   *  it. Version 2 snapshots carry the cap explicitly and become the queue's
   *  new hard ceiling. */
  restoreFromSnapshot(snapshot: unknown): void {
    if (!isRecord(snapshot)) {
      throw new Error("Unsupported FollowUpQueueSnapshot version: undefined")
    }
    const version = snapshot.version
    if (version !== 1 && version !== 2) {
      throw new Error(`Unsupported FollowUpQueueSnapshot version: ${String(version)}`)
    }
    if (!Array.isArray(snapshot.threads)) {
      throw new Error("Malformed FollowUpQueueSnapshot threads")
    }
    const nextMaxPerThread =
      version === 2
        ? (() => {
            if (typeof snapshot.maxPerThread !== "number") {
              throw new Error("Malformed FollowUpQueueSnapshot maxPerThread")
            }
            return normalizeMaxPerThread(snapshot.maxPerThread)
          })()
        : this.maxPerThread
    const nextMap = new Map<ThreadId, ThreadQueueState>()
    let maxSeq = -1
    for (const t of snapshot.threads) {
      if (!isRecord(t)) throw new Error("Malformed FollowUpQueueSnapshot thread")
      if (typeof t.threadId !== "string") throw new Error("Malformed FollowUpQueueSnapshot thread")
      if (!Array.isArray(t.entries)) throw new Error("Malformed FollowUpQueueSnapshot thread")
      const validated: FollowUp[] = []
      for (const raw of t.entries) {
        const e = assertFollowUp(raw)
        validated.push(e)
        const seq = parseSeq(e.id)
        if (seq > maxSeq) maxSeq = seq
      }
      const kept =
        validated.length > nextMaxPerThread
          ? validated.slice(validated.length - nextMaxPerThread)
          : validated
      if (kept.length === 0) continue
      nextMap.set(t.threadId as ThreadId, {
        entries: kept,
        head: 0,
      })
    }
    this.map.clear()
    for (const [tid, state] of nextMap) this.map.set(tid, state)
    this.maxPerThread = nextMaxPerThread
    this.nextSeq = maxSeq + 1
  }

  /** Reconstruct a queue from a snapshot. The seq counter is reset to one
   *  past the maximum existing seq so post-restore enqueues never collide
   *  with restored ids. */
  static fromSnapshot(snapshot: unknown): FollowUpQueue {
    const q = new FollowUpQueue()
    q.restoreFromSnapshot(snapshot)
    return q
  }
}
