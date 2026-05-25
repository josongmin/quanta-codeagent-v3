# ADR-0269 — Decision emit Phase 3: cap / jail / budget gates

**Date**: 2026-05-25
**Status**: Accepted (default-OFF)
**Depends on**: ADR-0239 (debug-tracer decision-event variant), ADR-0267 (Phase 2 — emit at admissibility-gate)
**Supersedes**: none

## Context

ADR-0267 wired the `DecisionEmitter` port at the three gate sites that live
INSIDE `runAdmissibilityGate`:

  - `kind:"permission"` — mode policy + permission stack
  - `kind:"rule"`       — prefix-rule DSL
  - `kind:"hook"`       — `pre_tool_use` hook (admit + deny)

That left **three gates outside the admissibility call graph** still silent:

| Gate    | Where the decision happens                                       |
| ------- | ---------------------------------------------------------------- |
| cap     | `dispatch.ts` (right after `CapEnforcer.check` returns a reminder) |
| jail    | `@/storage/service.ts#enforceJail` (free-function chokepoint)    |
| budget  | `loop.ts` per-turn epilogue (`BudgetMeter.checkExhausted()`)     |

The `DecisionEvent` type already enumerates `cap` / `jail` / `budget` in its
closed `kind` union (added in ADR-0239); ADR-0267 simply did not exercise
those discriminants. Phase 3 closes the wiring loop.

## Decision

Reuse the **existing** `DecisionEmitter` port from `@/stream` and the
existing `AgentConfig.decisionEmitter?` slot. **Do not** introduce a second
port. Each Phase 3 site receives the emitter from its caller (or, where the
caller is a free function, via a narrow module-level sink) and emits a
**deny-only** decision row when the gate fires.

### Three emit sites

**1. `kind:"cap"`** — emit in `dispatch.ts` immediately after the existing
`tool_progress` reminder fire. `CapEnforcer.check` returning a non-undefined
reminder IS the ADR-0062 ignored-hint signal — the gate's intervention. The
emit happens inside a new `handleCapReminder(config, call, reminder)` helper
so `dispatchToolInner`'s cognitive complexity stays at its pre-Phase-3
baseline (22, unchanged).

```ts
emitCapReminderDecision(config.decisionEmitter, {
  tool, toolCallId, reminder, turn,
})
```

**2. `kind:"jail"`** — emit in `@/storage/service.ts#enforceJail` via a
module-level optional sink (`setFsJailDecisionSink` / `clearFsJailDecisionSink`).
`enforceJail` is a free function reached from dozens of tool catch sites
through `resolvePath`/`resolveJailed`; threading a per-call emitter would
ripple across the entire tool slice for a default-OFF developer-mode signal.
The sink is invoked BEFORE the `FsJailError` throw, inside try/catch so a
throwing consumer cannot poison the throw path. Lifecycle: composition root
calls `setFsJailDecisionSink` at `runAgent` entry, `clearFsJailDecisionSink`
at exit.

**Last-writer-wins** for concurrent in-process sessions is accepted and
documented: events carry their own `path` so a tracer disambiguates by
content. The channel is observational telemetry, not authority.

**Slice fence**: `@/storage` MUST NOT depend on `@/stream`. The sink shape
is a STRUCTURAL mirror of `DecisionEvent` declared inline in `service.ts`
(same closed `kind`/`outcome` unions, same field names) — the wiring layer
(in `@/agent`) passes the real `DecisionEmitter` and TS structural typing
keeps both ends aligned without a cross-slice import.

**3. `kind:"budget"`** — emit in `loop.ts` per-turn epilogue, immediately
before `finish("budget_exhausted", ...)`. `BudgetMeter.checkExhausted()`
returning `exhausted=true` IS the hard-deny signal; the meter itself stays
pure (no emit inside the state machine).

```ts
emitBudgetExhaustedDecision(cfg.decisionEmitter, ex, { turn })
```

### Helper module

A new leaf `src/agent/decision-emit-phase3.ts` houses the three emit
helpers. It is intentionally separate from `admissibility-gate.ts`:

  - the Phase 2 helper consumes `AdmissibilityGateConfig` and runs inside
    the gate's call graph;
  - the Phase 3 sites are OUTSIDE that graph (dispatch / storage / loop);
  - keeping the helpers next to their consumer sites preserves the
    locality each emit's sanitisation contract needs.

`admissibility-gate.ts` is **NOT mutated** in Phase 3 — Phase 2 stays
byte-identical (regression-locked by the 16-case Phase 2 hellgate).

### Sanitisation contract

Mirrors ADR-0267:

  - **`reason`** is a short human-readable one-liner with categorical info
    only (tool name / cap dimension / dial value / ratio).
  - **`metadata`** carries kind-specific safe extras:
    - cap: `{ tool }` — tool name is already public registry surface.
    - jail: `{ path, root }` — the user supplied the path AND the path was
      REJECTED, so this event does NOT expose file contents.
    - budget: `{ kind, used, limit }` — numerical observations + closed dial
      dimension. All categorical.
  - No emit site spreads `action.input` / `call.input` / env values.

### Allow paths stay SILENT

Same posture as Phase 2 hook gate (which DOES emit allow), specialized for
Phase 3:

| Gate    | Allow emit? | Rationale                                             |
| ------- | ----------- | ----------------------------------------------------- |
| cap     | NO          | Reminder is a deny-signal; no reminder ⇒ allow ⇒ skip |
| jail    | NO          | Inside-jail paths are the silent majority — noise     |
| budget  | NO          | `exhausted=false` is the hot path; emit would be DoS  |

This is a deliberate departure from Phase 2 `kind:"hook"` (which emits both
admit and deny). The Phase 3 chokepoints fire much more frequently — every
fs operation hits `enforceJail`, every turn hits `checkExhausted` — and an
emit-on-allow would flood the debug-tracer.

## Consequences

**Default-OFF byte-identical**: every helper short-circuits when
`emitter === undefined`. With no `AgentConfig.decisionEmitter` and no
`setFsJailDecisionSink`, the slice adds **zero allocations** and **zero
visible bytes**. The 16-case Phase 2 hellgate and the broader 993-test agent
+ storage suite both stay green.

**Throw isolation**: every emit path is wrapped in try/catch. A misbehaving
emitter cannot turn a cap-reminder into a missing reminder, a jail throw
into a swallowed escape, or a budget exhaustion into a continued run. Three
hellgate cases (one per site) seal this.

**Cognitive complexity**: zero new branches added to high-complexity
functions. The cap site's branch was extracted into `handleCapReminder`;
the budget site is a 1-line addition inside an existing `if`; the jail site
is a 1-line call inside `enforceJail` (already short).

**Slice fence**: `@/storage` keeps its independence from `@/stream` via the
inline structural mirror (`FsJailDecisionEvent`). No new cross-slice imports.

## Test plan

`tests/unit/agent/decision-emit-phase3-hellgate.test.ts` — **14 cases** /
39 expects across three describes (cap / jail / budget):

  - shape: kind/outcome/reason/toolCallId/metadata exactly as declared
  - allow silence: no emit on the non-fire path
  - default-OFF: undefined emitter ⇒ no throw, no allocation
  - throw isolation: poison emitter does not poison the gate result
  - metadata sanitisation: only declared keys ({kind, used, limit} etc)
  - jail sink lifecycle: idempotent clear, last-writer-wins semantics

## Files

  - `src/agent/decision-emit-phase3.ts` (new) — 3 emit helpers
  - `src/agent/dispatch.ts` — `handleCapReminder` extracted, emit call added
  - `src/agent/loop.ts` — emit call added at the `budget_exhausted` site
  - `src/storage/service.ts` — module-level sink + `enforceJail` emit
  - `src/storage/index.ts` — barrel re-exports for the sink
  - `tests/unit/agent/decision-emit-phase3-hellgate.test.ts` (new) — hellgate

`admissibility-gate.ts`, `decision-emitter.ts`, and `types.ts#decisionEmitter`
are **not mutated** (Phase 2 stays byte-identical).
