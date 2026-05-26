# ADR-0329 — Context-events closure factory (ADR-0321 producer wire)

## Status

Accepted — 2026-05-27. Slice landed; composition-root wiring deferred to
ADR-0332.

## Context

ADR-0327 added a single optional slot to `AgentConfig`:

```ts
contextEventsForTurn?: () => readonly ContextEvent[]
```

That slot is the seam through which the agent loop receives the typed
`ContextEvent[]` (ADR-0320, ADR-0321) it splices into the next prompt
assembly. ADR-0327 deliberately did NOT specify HOW the closure is
constructed — only the shape.

This ADR specifies the closure's INTERNALS: how the slot's per-turn
function maintains state (prev snapshot, since cursor), how it talks to
the typed-event store, and how it composes a `turnId` for downstream
correlation. Goals:

1. **Single composition-root call wires the producer.** No god-config
   spreading the diff plumbing across multiple modules.
2. **NO-THROW closure boundary.** Any failure inside the producer
   degrades to "no diff this turn"; the agent loop's outer
   try/catch is redundant safety.
3. **Slice fence.** Closure factory lives in
   `src/agent/context-events-producer/` and imports only the two
   already-landed neighbours: `@/memory/typed-event` (ADR-0320) and
   `@/agent/context-change` (ADR-0321). No existing code is mutated.
4. **Default-OFF.** Calling the factory is opt-in; absence of a wire
   call leaves `AgentConfig.contextEventsForTurn` undefined and the
   loop behaves exactly as before.

## Decision

Ship `src/agent/context-events-producer/` (4 files):

- `types.ts` — `ContextSnapshotInput` (the per-turn shape supplied by
  the composition root) and `ContextEventsProducerConfig` (closed-port
  factory config: `store`, `getSnapshot`, optional `sessionId`, optional
  `now`).
- `factory.ts` — `createContextEventsProducer(cfg)` returning the
  stateful `() => readonly ContextEvent[]` closure.
- `index.ts` — barrel (3 names).
- `__tests__/factory.hellgate.test.ts` — 14 hellgate cases.

### Per-turn algorithm

The closure body executes 9 steps:

1. `getSnapshot()` ⇒ raw `ContextSnapshotInput`.
2. Normalise via `captureSnapshot` into a `TurnStateSnapshot`
   (handles optional `mode` / `model`).
3. If `prev` undefined (first call): set `prev = current`, set
   `lastTurnAt = at + 1`, return empty array.
4. Increment `turnCounter`; build `turnId`.
5. `detectContextChanges(prev, current, at, { turnId })` ⇒ events.
6. `store.append(...)` each event.
7. Update `prev = current`.
8. `store.since(lastTurnAt)` ⇒ visible slice for THIS turn.
9. Set `lastTurnAt = at + 1`. Return the visible slice.

### Spec decisions (baked into the factory)

- **`turnId` format**: `[sessionId:]t${n}` with `n` a 1-based monotonic
  counter scoped to the closure. `n=0` is the (un-emitted) baseline
  capture; the first DIFF turn is `t1`. Rationale: counter survives
  identical timestamps; the `at` field on the event carries wall-clock.
- **First call baseline-only**: no `prev` to diff against ⇒ return
  empty. Emitting "everything became X" on first call would double-
  count the system prompt.
- **Cursor advance to `at + 1` (EXCLUSIVE of past)**: the next turn's
  `since(lastTurnAt)` returns only strictly-newer events. The inclusive
  port contract (`since(at)` ⇒ `event.at >= at`) plus `+ 1` advance
  gives canonical "each event surfaces exactly once" semantics for
  monotonic clocks. Within ONE turn, all detector events share that
  turn's `at`, so they ALL surface together (the cursor was set
  BEFORE the turn's events were appended).
- **Monotonic-clock assumption**: default `Date.now` is monotonic
  enough for in-process use. With a non-monotonic injected clock that
  rewinds, events with `at < lastTurnAt` are silently dropped — this
  is a deliberate trade-off to avoid re-surfacing old events on every
  turn.
- **Skill activation `trigger = "system"`**: the detector defaults to
  `"system"` (it cannot infer the trigger from snapshot diff alone).
  Finer-grained classification (`user` / `auto`) lives in a separate
  skill-router seam.

### NO-THROW invariants (7)

| ID  | Failure point      | Effect                                            |
|-----|--------------------|---------------------------------------------------|
| I1  | `getSnapshot()`    | return `[]`; prev/cursor unchanged                 |
| I2  | `detectContextChanges` | return `[]`; prev/cursor unchanged; counter rewinds |
| I3  | `store.append`     | return `[]`; prev/cursor unchanged (atomicity)     |
| I4  | `store.since`      | return `[]`; prev IS updated; cursor unchanged    |
| I5  | First call         | baseline only; return `[]`                        |
| I6  | Clock injection    | producer never reads `Date.now` when `now` set    |
| I7  | sessionId optional | turnId omits prefix when absent                   |

I3 atomicity matters most: if `append` throws mid-batch, `prev` does
NOT advance, so the next turn re-runs the SAME diff and re-emits the
SAME events. This makes the producer crash-safe under transient store
failures.

## Non-goals

- **Composition-root wire** — deferred to ADR-0332. This ADR ships the
  closure factory only.
- **`mode_change` `reason` threading** — caller passes `reason`
  upstream via a separate seam (slash-command echo, etc.); the producer
  keeps the detector's `meta` minimal (`turnId` only).
- **Removed-skill deactivation events** — out of scope per ADR-0321
  detector contract.
- **Per-event `turnId` overrides** — the closure stamps ONE `turnId`
  per turn; events emitted in one turn share that id.

## Wiring (one-liner, ADR-0332)

```ts
// composition root (ADR-0332):
cfg.contextEventsForTurn = createContextEventsProducer({
  store,
  getSnapshot: () => ({
    cwd: ctx.cwd,
    mode: ctx.mode,
    model: ctx.model,
    repoRulesPaths: ctx.repoRulesPaths,
    activeSkills: ctx.activeSkills,
  }),
  sessionId: ctx.sessionId,
})
```

## Tests

14 hellgate cases covering: first-call baseline, no-change steady
state, single-field diff, multi-field diff, NO-THROW (getSnapshot /
append / since), cursor accuracy across calls, within-turn same-ms
boundary, deterministic clock injection, sessionId/turnId composition
(absent + present), skill activation system trigger, and mode change.
All 14 pass; tsc 0 errors / biome 0 errors for the slice.

## Slice fence

- Files: `src/agent/context-events-producer/*` + this ADR.
- Existing code: 0 bytes mutated.
- Imports: `@/memory/typed-event`, `@/agent/context-change` (both
  already in `main`).
- Re-exports from `@/agent`: NONE (default-OFF until ADR-0332).
