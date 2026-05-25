/**
 * Plan-queue helper (ADR-0128 + ADR-0221 per-msg mutators).
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
 * Plane-clean: imports only `node:crypto` + `@/shared` Result type
 * (type-only). Zero `@/agent/loop` / `@/agent/dispatch` / `@/permission`
 * / `@/llm` / `@/tool` — those are consumers, not collaborators.
 *
 * Contract (6):
 *   1. PURE STORE: in-memory only; no I/O, no SQLite. Persistence is follow-up.
 *   2. NO-THROW on the public surface (every method swallows internal errors
 *      and falls back to a safe value — `enqueue` always returns an
 *      `EnqueueResult`, `drain`/`peek` always return arrays; the 4 mutators
 *      return `Result` with typed error variants instead of throwing).
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
 *
 * Per-msg mutators (ADR-0221, Codex composer parity):
 *   retry / edit / delete / sendNow on each LIVE follow-up. `sendNow`
 *   bypasses the paused state via an injected `SendNowSink` — it does NOT
 *   abort/interrupt the current turn. When no sink is wired, `sendNow`
 *   returns `{ok:false, error:"send-not-possible"}` (byte-identical to a
 *   store with no mutators).
 */

import { createHash } from "node:crypto"
import type { Result } from "@/shared"

/** Where the follow-up originated. Closed enum so callers cannot smuggle a
 *  free-form source and so the replayer can branch deterministically. */
export type FollowUpSource =
  | "user_keystroke"
  | "voice_transcript"
  | "api_call"
  | "scheduled_reminder"
  /** ADR-0240 — saved-file inline-trigger dispatch (Aider `AI!`-style).
   *  A playbook frontmatter's `trigger: { comment-marker, watch-glob }`
   *  detected a marker in a saved file; the watcher enqueued a `/play
   *  <playbook>` follow-up so the next-turn boundary picks it up. */
  | "inline_trigger"

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

/** Error variants for the four per-msg mutators (ADR-0221).
 *
 *   - `not-found`     — `entryId` does not match any LIVE entry across all
 *                       threads (drained entries are tombstones — they NEVER
 *                       resurrect via retry/edit/delete; sendNow ignores
 *                       them too).
 *   - `already-active`— `retry` only. The entry is still LIVE in the queue,
 *                       so a "retry" would dedup to itself rather than
 *                       enqueue a second copy. Caller should `delete` then
 *                       `enqueue` if intent is "force a fresh entry".
 *   - `invalid-text`  — `edit` only. The new text is empty / whitespace-only
 *                       (after `.trim()`), or exceeds {@link MAX_FOLLOWUP_TEXT_BYTES}.
 *                       Symmetric with future enqueue-side validation.
 *   - `send-not-possible` — `sendNow` only. No {@link SendNowSink} was wired
 *                       at construction time, OR the sink threw / returned a
 *                       falsy ok flag. `sendNow` NEVER throws — it converts
 *                       sink errors to `send-not-possible` so the caller has
 *                       one channel for "I can't deliver this right now". */
export type QueueMutateError = "not-found" | "already-active" | "invalid-text" | "send-not-possible"

/** Max byte length for a single follow-up text (post-`edit`). 64 KiB is the
 *  same ceiling Codex applies to keystroke buffers and roughly 16k tokens
 *  worth of text — far above any reasonable mid-turn redirect. */
export const MAX_FOLLOWUP_TEXT_BYTES = 64 * 1024

/** Injection port for `sendNow`. The caller (apps/agent bootstrap) wires
 *  this to whatever surface "deliver a user message into the next LLM turn
 *  WITHOUT interrupting the current one" maps to in their assembly:
 *
 *    - REPL surface ⇒ append to the working-message queue read at the next
 *      turn boundary. The in-flight turn keeps streaming.
 *    - Headless / API surface ⇒ append to the next-prompt buffer.
 *
 *  Contract:
 *    - MUST NOT abort/interrupt the active turn (steering bypass).
 *    - MUST return `{ok:true}` on a successful enqueue into the next-turn
 *      sink, `{ok:false, reason}` if the sink itself cannot accept.
 *    - MUST NOT throw — `sendNow` catches throws and converts them, but
 *      well-behaved sinks return `{ok:false}` instead. */
export interface SendNowSink {
  /** Submit `text` for inclusion in the NEXT LLM turn. Synchronous —
   *  the store has already done all bookkeeping by the time this is
   *  called, so the sink just needs to record the message. */
  inject(input: SendNowInjection): { ok: true } | { ok: false; reason: string }
}

/** Payload handed to {@link SendNowSink.inject}. Carries enough envelope
 *  context (threadId, source, label, metadata) that a multi-thread sink can
 *  route to the right session. */
export interface SendNowInjection {
  readonly threadId: string
  readonly text: string
  readonly source: FollowUpSource
  readonly enqueuedAtMs: number
  readonly metadata: Readonly<Record<string, string>>
  readonly label?: string
}

/** In-memory plan-queue. 5 methods + 1 inspector + 4 per-msg mutators
 *  (ADR-0221). */
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

  // ─── ADR-0221 per-msg mutators ────────────────────────────────────

  /** Look up a LIVE entry by id across all threads. Returns the snapshot
   *  on hit, undefined on miss / drained. Surface used by `/queue` to
   *  resolve id-prefixes before mutating. */
  findEntry(entryId: string): FollowUp | undefined
  /** Re-enqueue an entry's text. Fails with `already-active` when the
   *  source entry is still LIVE (would dedup to itself). Caller's path is
   *  `delete` + `enqueue` when intent is "force a fresh entry". Returns
   *  the NEW follow-up on success — same fields as the source minus a
   *  fresh id, enqueuedAtMs, drainedIntoTurn=null. */
  retry(entryId: string): Result<FollowUp, QueueMutateError>
  /** Edit an entry's text in-place. The id stays stable so any UI handle
   *  (chip / inspector row) survives. The textHash is recomputed; if the
   *  new text would collapse to another LIVE entry's hash, the OTHER
   *  entry's `urgent` is OR-ed with this one's and the THIS entry is
   *  removed (caller sees `ok:true` with the SURVIVING entry — the merge
   *  target). When the new text matches the existing text (no-op), the
   *  same entry is returned unchanged. */
  edit(entryId: string, newText: string): Result<FollowUp, QueueMutateError>
  /** Remove an entry from the live queue. Drained entries are NOT
   *  reachable (already gone from the array) so `delete` on a drained
   *  id is `not-found`. */
  delete(entryId: string): Result<void, QueueMutateError>
  /** Send the entry NOW (paused state ignored). Removes the entry from
   *  the queue AND hands its payload to the wired {@link SendNowSink}.
   *  Does NOT abort/interrupt the active turn (steering bypass — the
   *  injection lands at the NEXT turn boundary). Returns
   *  `send-not-possible` when no sink is wired or the sink rejects. The
   *  entry is removed BEFORE the sink call so a sink-side throw does not
   *  leave the entry in a half-state; if the sink rejects, the caller
   *  observes a removed entry + a typed error and can re-enqueue. */
  sendNow(entryId: string): Result<void, QueueMutateError>
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
  /** Optional {@link SendNowSink} for `sendNow()`. Absent ⇒ every
   *  `sendNow` returns `{ok:false, error:"send-not-possible"}`
   *  (default-OFF byte-identical to a store that pre-dates ADR-0221). */
  readonly sendNowSink?: SendNowSink
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

/** Local Result constructors — duplicated here so plan-queue keeps its
 *  zero-runtime-dep posture (`@/shared` is type-only). Tiny enough that
 *  importing the runtime helpers would inflate the dep graph for no gain. */
const okR = <T>(value: T): Result<T, never> => ({ ok: true, value })
const errR = <E>(error: E): Result<never, E> => ({ ok: false, error })

export const defaultPlanQueueStore = (opts?: PlanQueueStoreOpts): PlanQueueStore => {
  const maxPerThread = Math.max(1, Math.floor(opts?.maxPerThread ?? DEFAULT_MAX_PER_THREAD))
  const now = opts?.now ?? Date.now
  const hash = opts?.hash ?? defaultHash
  const sendNowSink = opts?.sendNowSink
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

  /** Private enqueue body — used by both the public `enqueue` and `retry`.
   *  Returns the LIVE entry on dedup-collapse and the freshly-created
   *  entry on a clean insert (callers can read `.id` on either). */
  const enqueueInternal = (
    input: Omit<FollowUp, "id" | "enqueuedAtMs" | "textHash" | "drainedIntoTurn">,
  ): { entry: Entry; collapsed: boolean } => {
    const textHash = hash(input.text)
    const queue = store.get(input.threadId) ?? []
    if (!store.has(input.threadId)) store.set(input.threadId, queue)

    // Dedup: identical (threadId, textHash) among LIVE entries collapses.
    const existing = findDedup(queue, textHash)
    if (existing !== undefined) {
      // OR-in urgent — caller's later "this is actually urgent" should
      // upgrade the existing entry, never downgrade.
      if (input.urgent) existing.urgent = true
      return { entry: existing, collapsed: true }
    }

    counter += 1
    const id = `fu-${input.threadId}-${counter}`
    const enqueuedAtMs = now()
    const base: Entry = {
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
      // `label` is conditionally added below (exactOptional).
      textHash,
    }
    const withLabel: Entry = input.label !== undefined ? { ...base, label: input.label } : base
    queue.push(withLabel)
    evictIfOver(queue)
    return { entry: withLabel, collapsed: false }
  }

  /** Inner scan of one thread's queue for a live id match. Extracted so
   *  the outer `locateLive` stays under biome's cognitive-complexity cap
   *  (the nested loop + 3-way branch otherwise tips it to 17). */
  const scanQueueForId = (
    queue: Entry[],
    entryId: string,
  ): { index: number; entry: Entry } | null => {
    for (let i = 0; i < queue.length; i++) {
      const e = queue[i]
      if (e === undefined || e.id !== entryId) continue
      // drained id ⇒ tombstone (we don't actually keep these but the
      // guard documents the contract); same as not found for callers.
      if (e.drainedIntoTurn !== null) return null
      return { index: i, entry: e }
    }
    return null
  }

  /** Locate a LIVE entry by id (linear over all threads — queues are
   *  capped so the worst case is `maxPerThread × thread-count`, tiny in
   *  practice). Returns `null` when the entry is missing OR drained. */
  const locateLive = (entryId: string): { queue: Entry[]; index: number; entry: Entry } | null => {
    for (const queue of store.values()) {
      const hit = scanQueueForId(queue, entryId)
      if (hit !== null) return { queue, ...hit }
    }
    return null
  }

  /** Find the threadId whose array reference is `queue`. Reverse lookup —
   *  small Map so the O(n) sweep is trivial in practice. Returns
   *  undefined when the queue is no longer tracked (defensive only). */
  const findThreadIdForQueue = (queue: Entry[]): string | undefined => {
    for (const [tid, q] of store.entries()) {
      if (q === queue) return tid
    }
    return undefined
  }

  /** Delete the empty queue's map entry so `inspect`/`peek` see no stale
   *  thread keys. No-op when the queue is non-empty. */
  const cleanupEmptyQueue = (queue: Entry[]): void => {
    if (queue.length !== 0) return
    const tid = findThreadIdForQueue(queue)
    if (tid !== undefined) store.delete(tid)
  }

  /** Validate `newText` for `edit`. Returns the validated string on ok,
   *  the typed error on reject. Extracted to keep `edit` under the
   *  cognitive-complexity cap. */
  const validateEditText = (newText: unknown): Result<string, QueueMutateError> => {
    if (typeof newText !== "string") return errR("invalid-text")
    if (newText.trim().length === 0) return errR("invalid-text")
    if (Buffer.byteLength(newText, "utf8") > MAX_FOLLOWUP_TEXT_BYTES) return errR("invalid-text")
    return okR(newText)
  }

  /** Find a LIVE entry on `queue` whose `textHash` matches `nextHash` and
   *  is NOT `excluded`. Returns the merge target on hit, `null` on miss.
   *  Used by `edit` to detect collapse-with-sibling. */
  const findMergeTarget = (queue: Entry[], excluded: Entry, nextHash: string): Entry | null => {
    for (const other of queue) {
      if (other === excluded || other.drainedIntoTurn !== null) continue
      if (other.textHash === nextHash) return other
    }
    return null
  }

  return {
    enqueue(input) {
      const { entry, collapsed } = enqueueInternal(input)
      return { id: entry.id, collapsed }
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

    // ─── ADR-0221 per-msg mutators ──────────────────────────────────

    findEntry(entryId) {
      const located = locateLive(entryId)
      return located === null ? undefined : toSnapshot(located.entry)
    },

    retry(entryId) {
      const located = locateLive(entryId)
      if (located === null) return errR("not-found")
      const { queue, index, entry } = located
      // `already-active` is the guard for a future async-mutation regime —
      // today the store is synchronous single-threaded JS so the entry is
      // unambiguously LIVE here. The variant exists in the public Result
      // shape for forward-compat (the typed-error union is closed).
      //
      // Retry semantics: REMOVE the source entry, then re-enqueue with a
      // FRESH id + enqueuedAtMs + textHash. The remove-first step avoids
      // the dedup-with-self pitfall (`enqueueInternal` would collapse to
      // the source entry's id, returning a stale handle). The caller
      // observes the NEW snapshot in the success channel — the old id is
      // gone from the queue.
      queue.splice(index, 1)
      // If the queue is now empty, leave it — enqueueInternal will reuse
      // the same array reference (it does `store.get(threadId) ?? []`).
      const re = enqueueInternal({
        threadId: entry.threadId,
        text: entry.text,
        source: entry.source,
        pausedReason: entry.pausedReason,
        arrivedDuringTurn: entry.arrivedDuringTurn,
        urgent: entry.urgent,
        metadata: entry.metadata,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
      })
      return okR(toSnapshot(re.entry))
    },

    edit(entryId, newText) {
      const located = locateLive(entryId)
      if (located === null) return errR("not-found")
      const validated = validateEditText(newText)
      if (!validated.ok) return validated
      const text = validated.value

      const { queue, index, entry } = located
      const nextHash = hash(text)
      // No-op edit: same text ⇒ same hash. Fast-path avoids dedup work.
      if (nextHash === entry.textHash && text === entry.text) {
        return okR(toSnapshot(entry))
      }
      // Collapse-with-sibling: merge urgency + drop this, return survivor.
      // Mirrors enqueue-side dedup so edit + enqueue converge on same end.
      const mergeTarget = findMergeTarget(queue, entry, nextHash)
      if (mergeTarget !== null) {
        if (entry.urgent) mergeTarget.urgent = true
        queue.splice(index, 1)
        return okR(toSnapshot(mergeTarget))
      }
      // In-place text + hash swap. `text` and `textHash` are declared
      // `readonly` on `Entry` AND `FollowUp` — we bypass via a scoped
      // non-readonly view so external callers still cannot mutate while
      // the store retains the right to mutate its own internal records.
      const mutable = entry as { text: string; textHash: string }
      mutable.text = text
      mutable.textHash = nextHash
      return okR(toSnapshot(entry))
    },

    delete(entryId) {
      const located = locateLive(entryId)
      if (located === null) return errR("not-found")
      const { queue, index } = located
      queue.splice(index, 1)
      cleanupEmptyQueue(queue)
      return okR(undefined)
    },

    sendNow(entryId) {
      const located = locateLive(entryId)
      if (located === null) return errR("not-found")
      const { queue, index, entry } = located

      // Remove FIRST so a sink-side throw can't leave the entry in a
      // half-state (contract on the public docs: "entry removed before
      // sink call"). If the sink rejects, caller sees error + removed
      // entry; they can re-enqueue if intent demands.
      queue.splice(index, 1)
      cleanupEmptyQueue(queue)

      if (sendNowSink === undefined) return errR("send-not-possible")

      const payload: SendNowInjection = {
        threadId: entry.threadId,
        text: entry.text,
        source: entry.source,
        enqueuedAtMs: entry.enqueuedAtMs,
        metadata: entry.metadata,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
      }
      // No-throw guard: callers MUST NOT see a thrown error from a sink
      // they wired. Convert any throw / non-ok result to typed error.
      try {
        const r = sendNowSink.inject(payload)
        return r.ok === true ? okR(undefined) : errR("send-not-possible")
      } catch {
        return errR("send-not-possible")
      }
    },
  }
}
