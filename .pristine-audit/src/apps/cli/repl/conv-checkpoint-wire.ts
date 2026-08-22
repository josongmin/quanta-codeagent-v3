/**
 * Surface-side per-turn auto-record wire for the
 * {@link ConversationCheckpointStore} (ADR-0292).
 *
 * Position in the architecture:
 *
 *   - `src/agent/conversation-checkpoint.ts` (ADR-0124) ships the PURE
 *     in-memory snapshot/restore primitive — no loop coupling.
 *   - This file (ADR-0292) ships a CALLER-DRIVEN helper that surfaces
 *     wrap around the store at turn boundaries. The agent loop is
 *     UNCHANGED: only the host surface (CLI/Tauri) constructs a wire
 *     and calls `recordTurn(messages)` after each successful turn.
 *   - `/rewind-conv` (sibling file `../rewind-conv-cmd.ts`, ADR-0292)
 *     consumes the same wire via `SlashContext.convCheckpoint`.
 *
 * Default-OFF (RFC §1.2): when the host never instantiates this wire,
 * zero code paths in the loop are touched and zero allocations happen.
 * The slash command degrades to "not wired" (exit 0) symmetrically.
 *
 * No-throw guarantee: every method returns or no-ops. `record()` on the
 * underlying store is no-throw on the documented public surface; we add
 * an outer try/catch as a belt-and-suspenders against programmer-bug
 * inputs (e.g. a non-array slipping past the type system in JS callers).
 *
 * Plane-clean imports — `@/agent/conversation-checkpoint` and `@/llm`
 * ONLY. No `@/storage`, `@/permission`, `@/agent/loop`, no surface
 * adapters. Tag formatting is pure-string; LRU is the store's concern.
 */

import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type { Message } from "@/llm"

/** One entry returned by {@link ConvCheckpointWire.listTags}. */
export interface ConvCheckpointEntry {
  readonly tag: string
  readonly takenAt: number
  readonly len: number
}

/** Caller-driven wire. The host calls `recordTurn` at turn-end (post-
 *  successful-turn hook), `listTags` from the slash list view, and
 *  `restore` from the slash restore view. `stop()` defensively disables
 *  the wire — any subsequent `recordTurn` becomes a no-op. */
export interface ConvCheckpointWire {
  /** Snapshot `messages` under a freshly-minted tag (turn counter + clock
   *  ms by default). Idempotent on collision: if `tagFormat` happens to
   *  return the same tag twice, the second call REPLACES the first per
   *  the store's documented behavior (and the turn counter still ticks).
   *  Never throws. */
  recordTurn(messages: ReadonlyArray<Message>): void
  /** Newest-first list of tags. Deterministic insertion-order on tie
   *  (the store's `Map` preserves insertion order, reversed by `list()`). */
  listTags(): readonly ConvCheckpointEntry[]
  /** Restore the messages stored at `tag`, or `null` if absent. */
  restore(tag: string): ReadonlyArray<Message> | null
  /** Defensive disable — subsequent `recordTurn` calls are no-ops. */
  stop(): void
}

/** Wire constructor options. Every field is optional so the call-site
 *  reads `startConvCheckpointWire({ store })`. */
export interface ConvCheckpointWireOpts {
  /** Store to write into. Required — caller composes (in-memory or
   *  whatever future persistent variant lands). */
  readonly store: ConversationCheckpointStore
  /** Tag generator. Default: `turn-<counter>-<now()>`. Override surfaces
   *  in the listing verbatim (test seam). */
  readonly tagFormat?: (turn: number, now: number) => string
  /** Forwarded only for documentation/parity — the store owns its own
   *  cap (passed at `defaultConversationCheckpointStore({ maxEntries })`
   *  time). This wire does NOT re-cap; it surfaces whatever the store
   *  returns. The field is preserved so callers reading the type can see
   *  the relationship — and so future variants (persistent store) can
   *  consult the hint. Currently a no-op in the default impl. */
  readonly maxEntries?: number
  /** Clock for tag minting. Default: `Date.now`. */
  readonly now?: () => number
}

const defaultTagFormat = (turn: number, now: number): string => `turn-${turn}-${now}`

/** Construct a default wire. */
export const startConvCheckpointWire = (opts: ConvCheckpointWireOpts): ConvCheckpointWire => {
  const store = opts.store
  const tagFormat = opts.tagFormat ?? defaultTagFormat
  const now = opts.now ?? Date.now
  // Turn counter is monotonic across the wire's lifetime. Each successful
  // `recordTurn` ticks it; defensive `stop()` freezes future ticks.
  let turn = 0
  let stopped = false

  return {
    recordTurn(messages: ReadonlyArray<Message>): void {
      if (stopped) return
      turn += 1
      // Be defensive — if a caller hands us something that lies about its
      // type, the store will throw `ConversationCheckpointError`. Swallow
      // so the wire is no-throw on its public surface (RFC §1.2 — wire
      // failure must NEVER cascade into the loop).
      try {
        const tag = tagFormat(turn, now())
        store.record(tag, messages)
      } catch {
        // Intentionally suppressed — the wire is a defensive surface
        // observer, not a load-bearing path. Failure to checkpoint is
        // strictly less bad than crashing the loop.
      }
    },
    listTags(): readonly ConvCheckpointEntry[] {
      try {
        const snaps = store.list()
        return snaps.map((s) => ({ tag: s.id, takenAt: s.takenAt, len: s.messages.length }))
      } catch {
        return []
      }
    },
    restore(tag: string): ReadonlyArray<Message> | null {
      try {
        return store.restore(tag)
      } catch {
        return null
      }
    },
    stop(): void {
      stopped = true
    },
  }
}
