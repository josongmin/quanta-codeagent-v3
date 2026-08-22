/**
 * Cross-subagent todo readback port (ADR-0255).
 *
 * Roo absorption: bidirectional extension of ADR-0219 focus chain. ADR-0219
 * re-injects parent todos every N turns (one-way, single session); this slice
 * lets any session snapshot another session's todos and lets a child session
 * write updates that the host explicitly propagates back to the parent.
 *
 * Plane-clean: types-only at this layer. NO imports from `@/agent/loop`,
 * `@/agent/dispatch`, `@/agent/focus-chain`, `@/llm`, `@/tool`. Caller wires
 * the store at its composition seam.
 *
 * Default-OFF: the loop never constructs a store. Callers opt in via a
 * future `AgentConfig` slot; when absent the loop is byte-identical and no
 * subscription fires.
 *
 * Contracts (7):
 *   1. NO-THROW on every public method — bad input (empty id, malformed
 *      partial) is a no-op or returns a typed `Result.err`.
 *   2. PARENT ISOLATION — a child's `updateFrom` does NOT auto-mirror into
 *      the parent. Host MUST explicitly call `propagate(child, parent)` to
 *      merge. Prevents read-during-write races.
 *   3. PURE STATE — in-memory only. No persistence (Phase 2 if needed).
 *   4. FROZEN SNAPSHOTS — `snapshotFor` returns a frozen view. Mutating it
 *      MUST NOT corrupt the store.
 *   5. MONOTONIC `updatedAt` — every successful update strictly increases
 *      the snapshot's timestamp. Concurrent writes never share a value.
 *   6. LAST-WRITE-WINS by `updatedAt` — deterministic ordering under
 *      concurrent `updateFrom` (by injected clock).
 *   7. SUBSCRIBE-WITH-SNAPSHOT — `subscribe(sid, cb, { snapshot: true })`
 *      synchronously delivers the current snapshot before returning, then
 *      continues normally.
 */

import type { Result } from "@/shared"
import type { TodoItem, TodoSnapshot, UpdateError } from "./types"

/** Partial update payload — replaces items by `id` (upsert) when present,
 *  appends unknown ids. Empty `items` is a no-op but bumps `updatedAt` so
 *  observers still see a fresh tick. */
export interface TodoUpdate {
  readonly items: readonly TodoItem[]
}

/** Subscription handle. Calling `unsubscribe` is idempotent (multiple calls
 *  ⇒ first wins, rest no-op). When an `AbortSignal` is passed to
 *  `subscribe`, the host's external `abort()` triggers the same cleanup. */
export interface Subscription {
  unsubscribe(): void
}

/** Optional subscribe knobs — `exactOptionalPropertyTypes` posture: omit
 *  the field entirely instead of setting it to `undefined`. */
export interface SubscribeOpts {
  /** When true, the callback is invoked synchronously with the CURRENT
   *  snapshot before `subscribe` returns. The same callback then fires on
   *  every subsequent `updateFrom`. Default: false. */
  readonly snapshot?: boolean
  /** Optional `AbortSignal`. When aborted, the subscription's
   *  `unsubscribe` runs and the callback stops firing. */
  readonly signal?: AbortSignal
}

/** Callback signature — receives a frozen snapshot. The callback MUST NOT
 *  throw; the store catches and discards exceptions so one bad subscriber
 *  cannot starve siblings. */
export type SnapshotCallback = (snapshot: TodoSnapshot) => void

/** The full readback surface — five methods + the linkage helper. */
export interface TodoReadback {
  /** Read a frozen snapshot of `sessionId`'s todos. Unknown session ⇒
   *  empty snapshot with `updatedAt = 0` (NOT an error — readback is
   *  always safe). */
  snapshotFor(sessionId: string): TodoSnapshot
  /** Replace / upsert todos for `sessionId`. Unknown session ⇒
   *  `Err({ kind: "session-not-found", sessionId })`. Sessions are
   *  registered implicitly by `link` or by the first successful
   *  `updateFrom` against a session created by `link(parent, child)`. */
  updateFrom(sessionId: string, partial: TodoUpdate): Result<void, UpdateError>
  /** Register a session pair. After `link(parent, child)`, both
   *  `parent` and `child` are valid `updateFrom` / `snapshotFor`
   *  targets, and the child becomes eligible for `propagate(child,
   *  parent)`. Re-linking with the same pair is a no-op. */
  link(parent: string, child: string): void
  /** Subscribe to `sessionId` updates. Returns a `Subscription` whose
   *  `unsubscribe` halts further callbacks. See `SubscribeOpts` for the
   *  snapshot-on-subscribe knob and `AbortSignal` wiring. */
  subscribe(sessionId: string, cb: SnapshotCallback, opts?: SubscribeOpts): Subscription
  /** Explicitly merge the child's current snapshot into the parent's
   *  todo list (overwrite-by-id; unknown ids appended at end). Bumps
   *  the parent's `updatedAt` and fires the parent's subscribers.
   *  Unknown linkage ⇒ no-op (NOT an error — propagation is
   *  best-effort). */
  propagate(childSessionId: string, parentSessionId: string): void
}
