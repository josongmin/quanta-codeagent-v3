# ADR-0240: Loop trio integration — auto-background accept + automation engine tick + identity per-turn reminder

- **Status**: Accepted
- **Date**: 2026-05-25
- **Renumbered**: from initially-drafted ADR-0239 (collision with `0239-debug-tracer-decision-event.md` in user track). Per `adr-collision-policy-2026-05-25`: user keeps original, ours renumber to next-free 0240.
- **Related ADRs**: ADR-0223 (auto-background stuck detector — provides `propose-handler` invoked here), ADR-0215 (RRULE automation engine wire — `AutomationEnginePort.tickScheduler` invoked here), ADR-0211 (identity mode-variant + `ARCHITECT_NOTICE` / `EDITOR_NOTICE`), ADR-0140/0145 (BackgroundSubagentScheduler — target of auto-bg accept), ADR-0236 (composition root mega-wire — provides AgentConfig slots this work consumes)
- **References**:
  - `src/agent/loop.ts` (3 wire sites: automation ticker handle around line 1886 + start/stop + per-turn identity reminder splice)
  - `src/apps/agent/index.ts` (`startAutomationEngineTicker(cfg)` + default `autoBackground.onAccept` binding)
  - `src/agent/auto-background/propose-handler.ts` (`onAccept` callback signature)
  - `src/agent/prompt.ts` (`ARCHITECT_NOTICE` / `EDITOR_NOTICE` source — already in ADR-0211)
  - `tests/integration/auto-background-onaccept-fork-wire-hellgate.test.ts` (10 cases)
  - `tests/integration/automation-engine-tick-wire-hellgate.test.ts` (12 cases)
  - `tests/integration/identity-per-turn-reminder-hellgate.test.ts` (39 cases — exhaustive mode matrix)

## Context

ADR-0236 mega-wire shipped 11 AgentConfig slots with composition-root construction but explicitly deferred loop-body integration: *"Only `focusChain` runs in loop; other 10 slots are caller-side (slash/surface/tool/future ADR consumer)"*. Three of those slots have natural loop-body integration points that the caller-side model under-serves:

1. **`autoBackground.onAccept`** — the propose-handler emits accept events; without an in-loop handler the accept is observable only via host telemetry, not actionable.
2. **`automationEngine.tickScheduler`** — RRULE engine has no caller (host had to pull `tickScheduler({ now })` on a private timer; nothing in the agent did).
3. **`identityModeVariant`** — `architect` / `editor` modes need a per-turn reminder, not just a session-start system prompt swap (Codex `ARCHITECT_NOTICE` / `EDITOR_NOTICE` pattern). Without per-turn splice, multi-turn mode drift was visible in fixtures.

## Decision

Wire all three into `src/agent/loop.ts` directly, each behind a default-OFF knob:

### A. `autoBackground.onAccept` → `BackgroundSubagentScheduler.fork`
Composition root binds a default `onAccept` that calls `scheduler.fork({ continueFrom: toolCallId, ... })` when `cfg.subagentBackground` is wired. User-supplied `onAccept` takes precedence (custom callbacks shadow the default). Scheduler absent → graceful noop.

### B. `automationEngine.tickScheduler` — interval ticker on loop start
`startAutomationEngineTicker(cfg)` returns a handle; loop captures `automationTickerHandle` at start, calls `handle.stop()` at end. `setInterval` default 60000ms (knob `automationEngine.tickIntervalMs`). Each tick invokes `engine.tickScheduler({ now: Date.now() })` — due automations are processed by engine, inbox emit is engine-internal.

### C. Identity per-turn reminder splice
Per-turn prompt assembly checks `mode === "architect" || mode === "editor"` AND `cfg.identityModeVariant?.perTurnReminderEnabled !== false`. Splice corresponding NOTICE into the last user message (architect splices into system reminder context; editor splices verbatim before user content). Default behavior: ON for architect/editor, OFF for other modes (mode-conditional auto-ON).

## Hellgate (61 cases / 221 expects / 0 fail)

- `auto-background-onaccept-fork-wire-hellgate.test.ts` — 10 cases: accept→fork, dismiss→no-fork, custom callback precedence, scheduler-absent graceful, OFF parity, multi-call idempotency
- `automation-engine-tick-wire-hellgate.test.ts` — 12 cases: tick interval honored, due-automation invoked, inbox emit visible, engine-absent noop, OFF parity, `tickIntervalMs` knob respected, abort-clean cleanup, ticker stop on loop end
- `identity-per-turn-reminder-hellgate.test.ts` — 39 cases (mode × turn × knob matrix): architect splice, editor splice, default-mode no-splice, knob-off no-splice, multi-turn consistency, prompt boundary safety

## Configurable knobs (all default-safe)

- `AgentConfig.autoBackground.onAccept?: (toolCallId, elapsedMs) => void` — default: composition-root default forker (when subagent scheduler wired)
- `AgentConfig.automationEngine.tickIntervalMs?: number` — default 60000
- `AgentConfig.identityModeVariant.perTurnReminderEnabled?: boolean` — default: mode-conditional (architect/editor → true, else false)

## Default-OFF invariants

- `autoBackground` slot absent → byte-identical loop behavior, no propose-handler invocation
- `automationEngine` slot absent → ticker never started, no interval scheduled
- `identityModeVariant` slot absent → no NOTICE splice for any mode

## Consequences

- 3 of 11 ADR-0236 deferred slots are now closed-out with hellgate coverage; 8 remain caller-side by design (textInbox/planEdit/composerEdit/stickyModelStore/toolProfile/forkSession/delegation/playbookTrigger).
- Loop body grew by ~80 lines (justified by integration density — each wire is single-call and orthogonal).
- Per-turn reminder pattern establishes precedent for future mode-conditional prompt augmentation (codex parity reinforcement).
