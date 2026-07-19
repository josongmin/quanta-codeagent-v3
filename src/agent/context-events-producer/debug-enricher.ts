/**
 * ADR-0336 — Typed-event → debug-sink CONSUMER (the read side).
 *
 * ## Why this exists
 *
 * The codex-r2 typed-event store (`@/memory/typed-event`) was a DEAD
 * WRITE-SINK: producers `.append()` context-change / compaction / mention
 * events to it live (`codex-r2-wire-install/install.ts`), but NOTHING read
 * `store.snapshot()` / `store.since()` back — the events accumulated and
 * were never surfaced. This module is the GENUINE consumer: it drains the
 * store into the EXISTING bench trajectory debug-sink so each appended
 * typed event rides ALONGSIDE the recorded LLM turn as
 * `RecordedInteraction.metadata.debug.typedEvents` — an inspectable
 * surface the trajectory viewer already badges + renders.
 *
 * ## No new bus — reuse the debug-sink pull API
 *
 * The debug-sink (`@/apps/bench/trajectory-debug-sink`) already exposes a
 * PULL-style `register(enricher)` seam whose `sample()` is invoked at
 * every per-turn `drain()` and whose non-`undefined` return lands in
 * `metadata.debug[<key>]`. This factory produces exactly that enricher
 * shape — no new event bus, no new sink, no new recorder wire.
 *
 * ## Slice fence — structural DI, no `@/apps/bench` import
 *
 * `src/agent/**` may NOT import `@/apps/bench/**` (upward app dependency).
 * So this factory does NOT import `debugSink` / its `DebugEnricher` type;
 * it returns a STRUCTURALLY-compatible {@link TypedEventDebugEnricher}
 * (`{ key, sample }`) that the bench composition root registers via one
 * `debugSink.register(makeTypedEventDebugEnricher(store))` line. The
 * factory is pure + surface-agnostic; the register call is the only
 * composition-root edit.
 *
 * ## Incremental drain (genuine read, not re-emit)
 *
 * `sample()` reads `store.snapshot()` and returns ONLY the events appended
 * since the previous drain (closure-scoped `seen` cursor by count — the
 * store is append-only, so a count cursor is exact and never re-surfaces a
 * past event). Returns `undefined` when no new events accrued, so the
 * enricher contributes NOTHING on a quiet turn (keeps records lean; the
 * debug-sink omits the whole `debug` key when every enricher is quiet).
 *
 * A count cursor (not a timestamp) is used deliberately: the store's `at`
 * field can collide within a millisecond across producers, and `since(at)`
 * is boundary-INCLUSIVE, so a timestamp cursor would re-surface
 * same-millisecond events. Append-only ⇒ `snapshot().length` is monotone,
 * so `snapshot().slice(seen)` is the exact never-seen tail.
 *
 * ## NO-THROW
 *
 * A throwing store must not crash the recorder's drain. `sample()` wraps
 * the read in try/catch and returns `undefined` on throw (contribute
 * nothing), leaving the cursor UNADVANCED so the next drain retries the
 * same window.
 */

import type { TypedHistoryEvent, TypedHistoryEventStore } from "@/memory/typed-event"

/** The debug-sink `key` this enricher contributes under. Namespaced so it
 *  never collides with the existing `verdict` / `editTrace` / `toolExec`
 *  contributors. */
export const TYPED_EVENTS_DEBUG_KEY = "typedEvents" as const

/**
 * Structural mirror of the bench debug-sink's `DebugEnricher` (pull-style
 * contributor). Declared here — NOT imported from `@/apps/bench` — to keep
 * the slice fence intact. The bench composition root passes the returned
 * value straight to `debugSink.register(...)`; structural typing makes it
 * assignment-compatible without a cross-slice import.
 */
export interface TypedEventDebugEnricher {
  readonly key: string
  /** Sampled at every drain; `undefined` ⇒ contribute nothing this turn. */
  readonly sample: () => readonly TypedHistoryEvent[] | undefined
}

/**
 * Build the typed-event → debug-sink enricher for `store`.
 *
 * The returned enricher's `sample()` drains the never-seen tail of the
 * store on each call (incremental, count-cursored). Register it ONCE per
 * store on the debug-sink:
 *
 * ```ts
 * // bench composition root (apps/bench layer — may import both):
 * import { debugSink, isTrajectoryDebugEnabled } from "./trajectory-debug-sink"
 * import { makeTypedEventDebugEnricher } from "@/agent/context-events-producer"
 * if (isTrajectoryDebugEnabled()) debugSink.register(makeTypedEventDebugEnricher(store))
 * ```
 *
 * Default-OFF: the debug-sink itself is a no-op unless the trajectory
 * debug gate is set, so an unregistered / off-gate build never calls
 * `sample()` and the store read never runs (OFF byte-identical).
 */
export const makeTypedEventDebugEnricher = (
  store: TypedHistoryEventStore,
): TypedEventDebugEnricher => {
  // Count cursor into the append-only store. `snapshot().length` is
  // monotone, so `slice(seen)` is exactly the never-drained tail.
  let seen = 0
  return {
    key: TYPED_EVENTS_DEBUG_KEY,
    sample(): readonly TypedHistoryEvent[] | undefined {
      let all: readonly TypedHistoryEvent[]
      try {
        all = store.snapshot()
      } catch {
        // NO-THROW: a buggy store must not break the recorder's drain.
        // Leave the cursor unadvanced so the next drain retries.
        return undefined
      }
      if (all.length <= seen) return undefined // nothing new ⇒ contribute nothing
      const fresh = all.slice(seen)
      seen = all.length
      return fresh
    },
  }
}
