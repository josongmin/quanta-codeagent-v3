/**
 * ADR-0329 — `createContextEventsProducer`.
 *
 * Builds the stateful `contextEventsForTurn` closure that
 * AgentConfig's slot (ADR-0327) expects. Single composition-root
 * call wires the producer; no other code path is mutated.
 *
 * Per-turn algorithm (the closure body):
 *   1. `getSnapshot()` ⇒ raw {@link ContextSnapshotInput}.
 *   2. Normalise via {@link captureSnapshot} into a
 *      {@link TurnStateSnapshot} (handles `undefined` mode/model).
 *   3. If no `prev` (first call) ⇒ store baseline, return `[]`.
 *   4. `detectContextChanges(prev, current, at, meta)` ⇒ events.
 *   5. `store.append(...)` each event.
 *   6. Update `prev` snapshot ref.
 *   7. `store.since(lastTurnAt)` ⇒ slice of events visible THIS turn.
 *   8. Update `lastTurnAt = at` cursor.
 *   9. Return the since-slice.
 *
 * NO-THROW invariants (7):
 *   I1. `getSnapshot()` throws ⇒ `[]`, prev unchanged, cursor
 *       unchanged. The next turn retries cleanly.
 *   I2. `detectContextChanges` throws (defensive — current impl
 *       cannot) ⇒ `[]`, prev unchanged, cursor unchanged.
 *   I3. `store.append` throws ⇒ ATOMICITY: bail before mutating
 *       `prev` / cursor so a partial-append is observable to the
 *       NEXT turn as "still need to diff against the same prev".
 *   I4. `store.since` throws ⇒ `[]`, prev IS updated (the append
 *       half already succeeded, so the next turn must diff against
 *       the new baseline), cursor unchanged so same-millisecond
 *       events surface next turn.
 *   I5. First call (no prev) ⇒ baseline-only capture, return `[]`,
 *       cursor set to `at` so the next call's `since(at)` is
 *       boundary-inclusive (cf. port.ts `since` contract).
 *   I6. `now()` injected ⇒ producer never reads `Date.now` itself
 *       (determinism). Default = `Date.now` only when `now` absent.
 *   I7. `sessionId` absent ⇒ `meta.turnId = "t${n}"`; present ⇒
 *       `"${sessionId}:t${n}"`. The detector THREADS the id verbatim
 *       onto the event; never inspects content.
 *
 * Spec decisions baked into this factory:
 *   - `turnId` format `[sessionId:]t${n}` where `n` is a 1-based
 *     monotonic counter (closure-scoped, NOT reset). Chosen because
 *     `n` survives identical timestamps and is human-readable; the
 *     `at` field on the event carries the wall-clock.
 *   - First call is baseline-only — emits zero events even when the
 *     captured snapshot is non-empty. Rationale: there is no `prev`
 *     to diff against, and emitting "everything became X" would
 *     double-count the initial system prompt.
 *   - `lastTurnAt` cursor advances to `at + 1` (EXCLUSIVE of past
 *     events). This produces the canonical "each event surfaces
 *     exactly once" behaviour for monotonic clocks. Within ONE
 *     turn, multiple events emitted at the same `at` still surface
 *     together because `since(prevCursor)` is inclusive and
 *     `prevCursor <= at` always (since cursor was set BEFORE this
 *     turn's events were appended).
 *   - Assumes monotonic clock (default `Date.now` is monotonic
 *     enough for in-process use). With a non-monotonic injected
 *     clock that rewinds, events with `at < lastTurnAt` would be
 *     silently dropped — this is a deliberate trade-off so we don't
 *     re-surface old events on every turn.
 *
 * Non-goals:
 *   - Composition-root wire (ADR-0332).
 *   - `mode_change` reason threading (caller passes `reason` upstream
 *     via a separate seam; producer keeps the detector meta minimal).
 *   - Skill activation `trigger` source — the detector defaults to
 *     `"system"`; finer-grained classification lives in a separate
 *     skill-router seam.
 */

import type { TurnStateSnapshot } from "@/agent/context-change"
import { captureSnapshot, detectContextChanges } from "@/agent/context-change"
import type { ContextEvent } from "@/agent/context-change/types"
import type { ContextEventsProducerConfig, ContextSnapshotInput } from "./types"

const EMPTY: readonly ContextEvent[] = Object.freeze([])

/** Normalise the composition-root-supplied input into the detector's
 *  `TurnStateSnapshot`. Handles `undefined` for `mode` / `model` by
 *  delegating to `captureSnapshot`'s defaults (`"default"` / `""`). */
const normalise = (input: ContextSnapshotInput): TurnStateSnapshot =>
  captureSnapshot({
    cwd: input.cwd,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    repoRulesPaths: input.repoRulesPaths,
    activeSkills: input.activeSkills,
  })

/** Compose the optional `sessionId` prefix with the monotonic counter
 *  into the detector's `turnId`. Counter is 1-based — `n=0` is the
 *  baseline (un-emitted) capture, so the first DIFF turn is `t1`. */
const buildTurnId = (sessionId: string | undefined, n: number): string =>
  sessionId !== undefined ? `${sessionId}:t${n}` : `t${n}`

/**
 * Build the stateful `contextEventsForTurn` producer.
 *
 * See module header for full algorithm + 7 NO-THROW invariants.
 *
 * Returned closure shape matches `AgentConfig.contextEventsForTurn`:
 * `() => readonly ContextEvent[]`.
 */
export const createContextEventsProducer = (
  cfg: ContextEventsProducerConfig,
): (() => readonly ContextEvent[]) => {
  const { store, getSnapshot, sessionId } = cfg
  const now = cfg.now ?? Date.now

  // Closure state — captured once, never re-bound.
  let prev: TurnStateSnapshot | undefined
  let lastTurnAt = 0
  let turnCounter = 0

  return (): readonly ContextEvent[] => {
    // I1: getSnapshot may throw — swallow, return empty.
    let rawInput: ContextSnapshotInput
    try {
      rawInput = getSnapshot()
    } catch {
      return EMPTY
    }

    const current = normalise(rawInput)
    const at = now()

    // I5: first call ⇒ baseline only. Advance cursor to at+1 so
    //     the FIRST diff turn's since() excludes any events that
    //     may have been appended by another producer at <= at.
    if (prev === undefined) {
      prev = current
      lastTurnAt = at + 1
      return EMPTY
    }

    turnCounter += 1
    const turnId = buildTurnId(sessionId, turnCounter)

    // I2: detect may (defensively) throw.
    let events: readonly ContextEvent[]
    try {
      events = detectContextChanges(prev, current, at, { turnId })
    } catch {
      // Bail without mutating prev / cursor — same as I1.
      turnCounter -= 1
      return EMPTY
    }

    // I3: append atomicity — if ANY append throws, bail before
    //     mutating prev / cursor so the next turn retries against
    //     the SAME prev and emits the SAME events.
    try {
      for (const e of events) {
        store.append(e)
      }
    } catch {
      turnCounter -= 1
      return EMPTY
    }

    // Append succeeded ⇒ prev advances unconditionally.
    prev = current
    const cursor = lastTurnAt

    // I4: since may throw — prev already advanced, so we cannot
    //     undo. Keep cursor unchanged so the next turn's since
    //     re-covers this window (inclusive boundary).
    let visible: readonly ContextEvent[]
    try {
      visible = store.since(cursor)
    } catch {
      return EMPTY
    }

    lastTurnAt = at + 1
    return visible
  }
}
