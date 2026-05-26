/**
 * ADR-0329 — Context-events producer closure factory: shapes.
 *
 * `ContextSnapshotInput` is the per-turn capture surface the composition
 * root supplies to the closure. It mirrors the prompt-seam values the
 * model will see this turn, so the diff the producer emits reflects the
 * REAL state flip the next turn observes (not a stale read).
 *
 * The shape is a strict superset of {@link TurnStateSnapshot} (all
 * fields readonly, all primitives or string arrays) — the factory
 * normalises it into a `TurnStateSnapshot` before handing it to
 * {@link detectContextChanges}.
 *
 * `ContextEventsProducerConfig` carries the closed-port dependencies
 * (store, getSnapshot, optional sessionId, optional clock). Optional
 * fields use `?:` — `exactOptionalPropertyTypes` forbids
 * `undefined`-set; absent ⇒ defaults applied at construction time.
 */

import type { TypedHistoryEventStore } from "@/memory/typed-event"

/**
 * Per-turn snapshot input supplied by the composition root.
 *
 * `model` is optional because some providers do not surface a label
 * (port wraps multiple model names under one factory). Absent ⇒
 * captured as `""` (matches `captureSnapshot` default).
 */
export interface ContextSnapshotInput {
  readonly cwd: string
  readonly mode: string | undefined
  readonly model: string | undefined
  readonly repoRulesPaths: readonly string[]
  readonly activeSkills: readonly string[]
}

/**
 * Closed-port config for {@link createContextEventsProducer}.
 *
 * - `store`: ADR-0320 typed-history event store (NOT mutated outside
 *   `append` calls).
 * - `getSnapshot`: called once per closure invocation; returns the
 *   current snapshot. Errors are swallowed (NO-THROW invariant).
 * - `sessionId`: optional correlation prefix. Threaded into the
 *   detector's `meta.turnId` as `${sessionId}:t${n}`; absent ⇒
 *   `t${n}` alone.
 * - `now`: optional clock injection for determinism (tests). Default
 *   `Date.now`.
 */
export interface ContextEventsProducerConfig {
  readonly store: TypedHistoryEventStore
  readonly getSnapshot: () => ContextSnapshotInput
  readonly sessionId?: string
  readonly now?: () => number
}
