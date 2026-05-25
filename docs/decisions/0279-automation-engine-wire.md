# ADR-0279: Automation engine composition-root wire (E2 productization)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0161 (scheduler Phase A — JSONL store + runtime), ADR-0215 (`AutomationEnginePort` 5-verb seam + 3-table schema), ADR-0240 (loop-helper `startAutomationEngineTicker` arm/disarm)

## Context

ADR-0215 shipped the `AutomationEnginePort` (in-memory + sqlite adapters) and
ADR-0240 wired the `startAutomationEngineTicker` loop helper that drains
`tickScheduler` on a `setInterval`. The remaining gap was the **composition
root**: nothing called either path. Operators who set `QUANTA_AUTOMATION=on`
got byte-identical legacy because:

1. No code instantiated an `AutomationEnginePort` at startup.
2. No code installed an `AgentLoopPort`-bound `handler` to translate
   `tickScheduler` fires into agent invocations.
3. The unified-agent surface (`src/apps/agent/index.ts`) had no `automationEngine`
   slot population.

Codex's `~/.codex/automations.sqlite` + scheduler runtime + inbox forms the
production reference: cron tick → due check → spawn agent → row in
`automation_runs` → entry in `inbox_items`. We had every primitive but no
seam from env → engine → tick → handler → `enqueueUserMessage`.

## Decision

Add `assembleAutomation(env, deps)` in `src/scheduler/runtime-wire.ts` — the
**single composition-root helper** that returns either:

- `null` — `QUANTA_AUTOMATION !== "on"` (default-OFF byte-identical; the
  caller's spread-conditional ensures the slot is OMITTED), OR
- `{ engine, handler, tickIntervalMs, onTick?, now? }` — a fully-wired
  `AutomationEngineSlot` ready to spread into `AgentConfig.automationEngine`.

The helper composes:

- **engine** — `inMemoryAutomationEngine()` by default (zero deps); sqlite
  adapter is available behind `QUANTA_AUTOMATION_STORE=sqlite` (host opens
  the `Database` and passes it through `deps.openSqlite`).
- **handler** — a closure over the host's `AgentLoopPort` that re-dispatches
  the automation's `prompt` via `enqueueUserMessage`. Handler errors surface
  as `kind:"errored"` outcomes (NOT thrown) — the loop helper's
  `tickScheduler` is no-throw by contract.
- **tickIntervalMs** — `QUANTA_AUTOMATION_INTERVAL_MS` (default 60000;
  invalid / 0 / negative / NaN ⇒ `null` slot + `logger.warn`).
- **onTick** — optional observer that writes terminal outcomes to the
  inbox (the `markRun` inside `tickScheduler` already populates the
  engine's inbox + runs tables; `onTick` is for surface telemetry —
  default writes a stderr line on `errored` outcomes only, never `fired`
  / `idle` to avoid stdout pollution).

### Composition-root call site

`src/apps/agent/index.ts` is the single touchpoint. `buildBaseFromArgs`
calls `assembleAutomation(env, { agentLoop })` and spreads the result via
`exactOptionalPropertyTypes`-safe conditional:

```ts
const automationSlot = assembleAutomation(env, { agentLoop })
return {
  ...base,
  ...(automationSlot !== null ? { automationEngine: automationSlot } : {}),
}
```

Loop-helpers `startAutomationEngineTicker` (ADR-0240) consumes the slot at
session-start; ADR-0240 already handles the timer arm/disarm + abort
plumbing — this slice is purely **composition-root construction**.

## Invariants

- **Default-OFF** — `QUANTA_AUTOMATION !== "on"` ⇒ `null` ⇒ slot OMITTED ⇒
  byte-identical legacy. Tested by HELL-AW-19.
- **No throw** — `assembleAutomation` never throws (invalid env ⇒ `null` +
  `logger.warn`). The handler closure is also no-throw (catches
  `enqueueUserMessage` rejections and rethrows them only to land in
  `tickScheduler`'s try/catch as `kind:"errored"`).
- **AbortSignal-clean** — the slot itself does NOT own an AbortController;
  the loop's `finish()` calls `handle.stop()` on the ticker (idempotent).
  Stopping mid-tick lets the in-flight `tickScheduler` finalize the
  current run row before returning. Tested by HELL-AW-09 / HELL-AW-21.
- **Concurrent-due safe** — when N rows are simultaneously due,
  `tickScheduler` fires the SOONEST-due-by-id one per tick (`next()` is
  closed over `nextRunAt ASC, id ASC`); the next tick picks the next.
  This is single-row-per-tick by design (matches Codex). Tested by
  HELL-AW-05.
- **engine ↔ persistence layering** — the engine writes runs + inbox on
  `markRun` (in-memory: arrays; sqlite: 3-table tx). The `onTick`
  observer is OBSERVATION-ONLY — it must not mutate engine state.

## Consequences

Positive:
- Closes the last gap in the E2 productization track: an operator who sets
  `QUANTA_AUTOMATION=on` now gets a real scheduled-agent loop with audit
  trail (runs) + notification surface (inbox).
- All wiring lives in ONE file (`runtime-wire.ts`) — easy to disable, easy
  to audit, easy to remove if the feature is rolled back.
- No change to `runtime.ts` / `automation-engine/*` / `loop-helpers.ts` —
  this slice is purely additive helper + composition-root call.

Negative invariants:
- We do NOT modify the existing `SchedulerRuntime` (the older Phase-E
  surface tied to JSONL store). The two paths coexist; this wire is for
  the new engine seam.
- We do NOT auto-schedule any automations. The host's CRUD path (slash
  command / tool) populates the engine; an empty engine ticks idle every
  60s (effectively zero-cost).

## Validation

22 hellgate cases in `tests/unit/scheduler/automation-wire-hellgate.test.ts`:
4 happy-path / 10 corner / 4 tool+banner / 4 wire+cleanup.
