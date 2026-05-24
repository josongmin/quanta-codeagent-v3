/**
 * Plan-queue helper (ADR-0128).
 *
 * Pure in-memory queue of follow-up user inputs captured WHILE a turn is in
 * progress, replayed when the turn ends. Codex's unique `queued-follow-ups`
 * pattern — no other modern agent has it (Claude Code / Cursor / v0 freeze
 * the UI mid-turn). quanta absorbs the STRUCTURAL surface (12-field FollowUp
 * + per-thread LRU + dedup) so a future consumer (mid-turn-steering wire,
 * CLI typed-while-running keystroke) can plug in on its own schedule.
 *
 * Default-OFF: nothing in the loop instantiates this store today. Callers
 * (apps/agent bootstrap, future mid-turn-steering wire) opt in by
 * constructing `defaultPlanQueueStore()` and calling `enqueue(...)` when the
 * user submits input mid-turn, then `drain(threadId, currentTurn)` at turn
 * boundary. Voice-matches ADR-0123 (verify-checkpoint bridge) and ADR-0124
 * (conversation-checkpoint store) — helper-only, deferred-wire posture.
 *
 * Plane-clean: imports only `node:crypto`. Zero `@/agent/loop` / `@/permission`
 * / `@/llm` / `@/tool` — those are consumers, not collaborators.
 *
 * Contract (6):
 *   1. PURE STORE: in-memory only; no I/O, no SQLite. Persistence is follow-up.
 *   2. NO-THROW on the public surface (every method swallows internal errors
 *      and falls back to a safe value — `enqueue` always returns an
 *      `EnqueueResult`, `drain`/`peek` always return arrays).
 *   3. exactOptionalPropertyTypes: optional input fields (`label`) are
 *      OMITTED on the stored entry when omitted by the caller — never
 *      `label: undefined`.
 *   4. PER-THREAD ISOLATION: queues are keyed by `threadId`; the same text
 *      enqueued on two threads stays as two entries (dedup is per-thread,
 *      NOT global).
 *   5. DEDUP WINDOW: dedup matches ONLY against entries still queued
 *      (`drainedIntoTurn === null`). A drained entry never collapses a new
 *      identical re-type — the replayer already saw the first one.
 *   6. LRU eviction: when a thread exceeds `maxPerThread`, the OLDEST
 *      NON-URGENT entry is dropped first. If every entry is urgent, the
 *      OLDEST URGENT is dropped — the cap is a hard ceiling; caller cannot
 *      prevent overflow, so we must drop something. Documented trade-off.
 */

import { createHash } from "node:crypto"

/** Where the follow-up originated. Closed enum so callers cannot smuggle a
 *  free-form source and so the replayer can branch deterministically. */
export type FollowUpSource =
  | "user_keystroke"
  | "voice_transcript"
  | "api_call"
  | "scheduled_reminder"

/** Why the current turn was paused when the follow-up arrived. Captured so
 *  the replayer can branch on staleness (e.g. drop follow-ups whose
 *  `pausedReason` was `rate_limit` if the user already retried). */
export type PausedReason =
  | "tool_in_flight"
  | "subagent_running"
  | "review_blocked"
  | "compaction"
  | "rate_limit"
  | "other"

/** 12-field follow-up context. Mirrors `codex-follow-up-queue-pattern`
 *  memory but typed and trimmed to fields the v3 consumer surfaces ACTUALLY
 *  read (Codex's are JSON-attached blobs; ours are typed scalars). */
export interface FollowUp {
  /** Stable id within ONE thread: `fu-${thread}-${n}`. Counter is per-store
   *  (not per-thread) so the suffix is monotone across threads too. */
  readonly id: string
  /** Owning thread / session id. */
  readonly threadId: string
  /** Free text the user submitted (or transcript / API call body). */
  readonly text: string
  /** Source surface — keystroke vs voice vs API vs scheduled. */
  readonly source: FollowUpSource
  /** Epoch ms when enqueued (from the injected clock). */
  readonly enqueuedAtMs: number
  /** Reason the current turn was paused when this arrived. */
  readonly pausedReason: PausedReason
  /** The turn index that was in-flight when this was enqueued. */
  readonly arrivedDuringTurn: number
  /** User-marked urgent (UI hint). Replayer may re-order; LRU eviction
   *  prefers to drop non-urgent first. MUTABLE inside the store (OR-in
   *  during dedup); external readers see it via the `FollowUp` shape but
   *  must not mutate. */
  urgent: boolean
  /** When the replayer surfaced this back into the active prompt, the
   *  resulting turn index. `null` until `drain()` claims it. */
  drainedIntoTurn: number | null
  /** Free metadata payload — caller-controlled (e.g. {viewportFile: "..."}). */
  readonly metadata: Readonly<Record<string, string>>
  /** Hash of the text — for dedup on identical re-types. */
  readonly textHash: string
  /** Optional user-facing label — UI-visible chip in the queue inspector.
   *  Omitted (not `undefined`) when the caller didn't supply one. */
  readonly label?: string
}

/** Result of `PlanQueueStore.enqueue`. ADR-0167 — expanded from bare `string`
 *  so observability wrap can emit a collapse counter (caller could not see
 *  dedup collapses when only the id was returned). */
export interface EnqueueResult {
  /** Assigned id (existing entry's id when collapsed). */
  readonly id: string
  /** True when this enqueue collapsed into an existing live entry
   *  (same threadId + same textHash, both with drainedIntoTurn===null).
   *  When true, `id` is the existing entry's id. */
  readonly collapsed: boolean
}

/** In-memory plan-queue. 5 methods + 1 inspector. */
export interface PlanQueueStore {
  /** Enqueue a follow-up. Returns `{id, collapsed}`. Dedup: identical
   *  `(threadId, textHash)` within the same paused window collapses
   *  (existing entry's `urgent` is OR-ed in; no second entry created and
   *  the EXISTING id is returned with `collapsed:true`). */
  enqueue(
    input: Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">,
  ): EnqueueResult
  /** Drain everything queued for `threadId`, in enqueued order (urgent
   *  first if multiple share the same enqueuedAtMs). Marks each as
   *  `drainedIntoTurn = currentTurn`. Returns the drained list. */
  drain(threadId: string, currentTurn: number): ReadonlyArray<FollowUp>
  /** Read without draining. Returns a snapshot — mutating it does not
   *  affect the store. */
  peek(threadId: string): ReadonlyArray<FollowUp>
  /** Drop everything for `threadId` (session end). Returns count removed. */
  clear(threadId: string): number
  /** Cross-thread snapshot for UI / observability. The returned Map and
   *  per-thread arrays are SNAPSHOTS — mutating them does not affect the
   *  store. */
  inspect(): ReadonlyMap<string, ReadonlyArray<FollowUp>>
}

export interface PlanQueueStoreOpts {
  /** Cap per thread — when exceeded, OLDEST non-urgent dropped first.
   *  Default 32 (Codex ships somewhere around 16-64; 32 is the safe mid).
   *  Values < 1 are clamped to 1. */
  readonly maxPerThread?: number
  /** Injected clock; tests pin it. Default `Date.now`. */
  readonly now?: () => number
  /** Injected hasher for textHash. Default = `sha256(text).slice(0,16)`. */
  readonly hash?: (text: string) => string
}

const DEFAULT_MAX_PER_THREAD = 32

/** Default SHA-256 16-hex-char prefix hasher. Matches the workspaceHash
 *  posture from ADR-0108 (16 hex chars = 64 bits = collision-safe at
 *  realistic queue sizes). */
const defaultHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

/** Internal mutable entry. We never widen `urgent` outside the store
 *  (consumer reads via `FollowUp` shape), and the `drainedIntoTurn`
 *  transition is the only other mutation. */
type Entry = {
  readonly id: string
  readonly threadId: string
  readonly text: string
  readonly source: FollowUpSource
  readonly enqueuedAtMs: number
  readonly pausedReason: PausedReason
  readonly arrivedDuringTurn: number
  urgent: boolean
  drainedIntoTurn: number | null
  readonly metadata: Readonly<Record<string, string>>
  readonly textHash: string
  readonly label?: string
}

/** Build an external `FollowUp` snapshot from a mutable internal entry.
 *  Omits `label` when not present (exactOptionalPropertyTypes — never
 *  `label: undefined`). */
const toSnapshot = (e: Entry): FollowUp => {
  const base: Omit<FollowUp, "label"> = {
    id: e.id,
    threadId: e.threadId,
    text: e.text,
    source: e.source,
    enqueuedAtMs: e.enqueuedAtMs,
    pausedReason: e.pausedReason,
    arrivedDuringTurn: e.arrivedDuringTurn,
    urgent: e.urgent,
    drainedIntoTurn: e.drainedIntoTurn,
    metadata: e.metadata,
    textHash: e.textHash,
  }
  if (e.label !== undefined) {
    return { ...base, label: e.label }
  }
  return base
}

export const defaultPlanQueueStore = (opts?: PlanQueueStoreOpts): PlanQueueStore => {
  const maxPerThread = Math.max(1, Math.floor(opts?.maxPerThread ?? DEFAULT_MAX_PER_THREAD))
  const now = opts?.now ?? Date.now
  const hash = opts?.hash ?? defaultHash
  // Per-thread queue: insertion order = arrival order. Drained entries
  // STAY in the array (with `drainedIntoTurn != null`) so the dedup window
  // can correctly exclude them; `peek` filters them out.
  // Actually — drained entries are REMOVED at drain time. The dedup window
  // therefore checks only live entries; the in-array state is always
  // "queued or drained-then-still-here-because-of-batch". To keep peek/
  // inspect O(n) without re-filtering, we delete drained entries from the
  // array during drain.
  const store = new Map<string, Entry[]>()
  let counter = 0

  /** Search live (non-drained) entries for a dedup match. */
  const findDedup = (queue: Entry[], textHash: string): Entry | undefined => {
    for (const e of queue) {
      if (e.drainedIntoTurn === null && e.textHash === textHash) return e
    }
    return undefined
  }

  /** Find the index of the oldest live entry in `queue` matching `predicate`.
   *  "Oldest" = smallest `enqueuedAtMs`. Drained entries are ALWAYS skipped
   *  (they're zombies awaiting GC). Returns -1 if no match. */
  const findOldestLiveIndex = (queue: Entry[], predicate: (e: Entry) => boolean): number => {
    let bestIdx = -1
    let bestAt = Number.POSITIVE_INFINITY
    for (let i = 0; i < queue.length; i++) {
      const e = queue[i]
      if (e === undefined) continue
      if (e.drainedIntoTurn !== null) continue
      if (!predicate(e)) continue
      if (e.enqueuedAtMs < bestAt) {
        bestIdx = i
        bestAt = e.enqueuedAtMs
      }
    }
    return bestIdx
  }

  const isNonUrgent = (e: Entry): boolean => !e.urgent
  const isAnyLive = (_e: Entry): boolean => true

  /** LRU eviction: drop oldest non-urgent; if all urgent, drop oldest
   *  urgent (documented trade-off — the cap is a hard ceiling). */
  const evictIfOver = (queue: Entry[]): void => {
    while (queue.length > maxPerThread) {
      // Tier 1: oldest non-urgent.
      const nonUrgentIdx = findOldestLiveIndex(queue, isNonUrgent)
      if (nonUrgentIdx >= 0) {
        queue.splice(nonUrgentIdx, 1)
        continue
      }
      // Tier 2 (all-urgent fallback): oldest urgent. Caller cannot prevent
      // overflow ⇒ we MUST drop something. Documented in contract #6.
      const urgentIdx = findOldestLiveIndex(queue, isAnyLive)
      if (urgentIdx >= 0) {
        queue.splice(urgentIdx, 1)
        continue
      }
      // Nothing live to evict (every entry is drained — drain would have
      // removed them). Defensive break to avoid infinite loop.
      break
    }
  }

  return {
    enqueue(input) {
      const textHash = hash(input.text)
      const queue = store.get(input.threadId) ?? []
      if (!store.has(input.threadId)) store.set(input.threadId, queue)

      // Dedup: identical (threadId, textHash) among LIVE entries collapses.
      const existing = findDedup(queue, textHash)
      if (existing !== undefined) {
        // OR-in urgent — caller's later "this is actually urgent" should
        // upgrade the existing entry, never downgrade.
        if (input.urgent) existing.urgent = true
        return { id: existing.id, collapsed: true }
      }

      counter += 1
      const id = `fu-${input.threadId}-${counter}`
      const enqueuedAtMs = now()
      const entry: Entry = {
        id,
        threadId: input.threadId,
        text: input.text,
        source: input.source,
        enqueuedAtMs,
        pausedReason: input.pausedReason,
        arrivedDuringTurn: input.arrivedDuringTurn,
        urgent: input.urgent,
        drainedIntoTurn: null,
        metadata: input.metadata,
        textHash,
        // `label` is conditionally added below (exactOptional).
      }
      const withLabel: Entry = input.label !== undefined ? { ...entry, label: input.label } : entry
      queue.push(withLabel)
      evictIfOver(queue)
      return { id, collapsed: false }
    },

    drain(threadId, currentTurn) {
      const queue = store.get(threadId)
      if (queue === undefined || queue.length === 0) return []
      // Snapshot live entries in (urgent first, then enqueued order)
      // ordering. Stable sort: ties resolved by enqueue order (array index).
      const live = queue.filter((e) => e.drainedIntoTurn === null)
      if (live.length === 0) return []
      const indexed = live.map((e, idx) => ({ e, idx }))
      indexed.sort((a, b) => {
        // urgent first (true > false)
        if (a.e.urgent !== b.e.urgent) return a.e.urgent ? -1 : 1
        // then enqueuedAtMs ascending
        if (a.e.enqueuedAtMs !== b.e.enqueuedAtMs) return a.e.enqueuedAtMs - b.e.enqueuedAtMs
        // then original index (stable tiebreak)
        return a.idx - b.idx
      })
      const drained: FollowUp[] = []
      for (const { e } of indexed) {
        e.drainedIntoTurn = currentTurn
        drained.push(toSnapshot(e))
      }
      // Remove drained entries from the live queue so future dedup /
      // peek / inspect see only live entries.
      const remaining = queue.filter((e) => e.drainedIntoTurn === null)
      if (remaining.length === 0) {
        store.delete(threadId)
      } else {
        // Replace contents in-place to keep the same array identity.
        queue.length = 0
        queue.push(...remaining)
      }
      return drained
    },

    peek(threadId) {
      const queue = store.get(threadId)
      if (queue === undefined || queue.length === 0) return []
      const live = queue.filter((e) => e.drainedIntoTurn === null)
      return live.map(toSnapshot)
    },

    clear(threadId) {
      const queue = store.get(threadId)
      if (queue === undefined) return 0
      const n = queue.filter((e) => e.drainedIntoTurn === null).length
      store.delete(threadId)
      return n
    },

    inspect() {
      const snapshot = new Map<string, ReadonlyArray<FollowUp>>()
      for (const [tid, queue] of store.entries()) {
        const live = queue.filter((e) => e.drainedIntoTurn === null)
        if (live.length === 0) continue
        snapshot.set(tid, live.map(toSnapshot))
      }
      return snapshot
    },
  }
}
