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
 *
 * Body decomposition: the public types + leaf helpers live in
 * `./plan-queue-shared` (re-exported below for back-compat); the per-method
 * bodies live in `./plan-queue/internals` and the factory just threads the
 * closed-over state (`store` Map by reference, `counter` boxed) into them.
 */

import type { Result } from "@/shared"
import {
  type CounterBox,
  clearMethod,
  deleteMethod,
  drainMethod,
  editMethod,
  enqueueMethod,
  findEntryMethod,
  inspectMethod,
  peekMethod,
  retryMethod,
  sendNowMethod,
} from "./plan-queue/internals"
import {
  DEFAULT_MAX_PER_THREAD,
  defaultHash,
  type EnqueueResult,
  type Entry,
  type FollowUp,
  type PlanQueueStoreOpts,
  type QueueMutateError,
} from "./plan-queue-shared"

export type {
  EnqueueResult,
  FollowUp,
  FollowUpSource,
  PausedReason,
  PlanQueueStoreOpts,
  QueueMutateError,
  SendNowInjection,
  SendNowSink,
} from "./plan-queue-shared"
export { MAX_FOLLOWUP_TEXT_BYTES } from "./plan-queue-shared"

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

export const defaultPlanQueueStore = (opts?: PlanQueueStoreOpts): PlanQueueStore => {
  const maxPerThread = Math.max(1, Math.floor(opts?.maxPerThread ?? DEFAULT_MAX_PER_THREAD))
  const now = opts?.now ?? Date.now
  const hash = opts?.hash ?? defaultHash
  const sendNowSink = opts?.sendNowSink
  // Per-thread queue: insertion order = arrival order. Drained entries are
  // REMOVED at drain time, so the dedup window checks only live entries and
  // peek/inspect stay O(n) without re-filtering for tombstones.
  const store = new Map<string, Entry[]>()
  const counter: CounterBox = { value: 0 }

  // The closed-over state is threaded into the extracted method bodies BY
  // REFERENCE (the `store` Map, the `counter` box) so every mutation lands on
  // the same records the returned object exposes — byte-identical to inlining.
  const deps = { maxPerThread, now, hash, sendNowSink, store, counter }

  return {
    enqueue: (input) => enqueueMethod(deps, input),
    drain: (threadId, currentTurn) => drainMethod(deps, threadId, currentTurn),
    peek: (threadId) => peekMethod(deps, threadId),
    clear: (threadId) => clearMethod(deps, threadId),
    inspect: () => inspectMethod(deps),
    findEntry: (entryId) => findEntryMethod(deps, entryId),
    retry: (entryId) => retryMethod(deps, entryId),
    edit: (entryId, newText) => editMethod(deps, entryId, newText),
    delete: (entryId) => deleteMethod(deps, entryId),
    sendNow: (entryId) => sendNowMethod(deps, entryId),
  }
}
