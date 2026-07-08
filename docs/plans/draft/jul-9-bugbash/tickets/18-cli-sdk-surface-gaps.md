# ALBB-18 — CLI / SDK semantic-label + observability polish

**Priority:** P3 (downgraded from P2 — see Severity note)
**Wave:** D
**Depends on:** ALBB-04, ALBB-12
**Owner:** `src/apps/cli/repl/session-loop.ts`, `src/sdk/run.ts`,
`src/host/runtime/internal/session-host-turn-event-bridge.ts`,
`src/host/runtime/internal/context-binding/approval-support.ts`

## Goal

Fix five semantic-label / observability gaps on the REPL reactor path and the
session-protocol / SDK consumer surfaces. This is a **cleanup bundle**, not a
correctness fix — none of the five change default behavior, and the headline
"abort → fail" item has **no reachable behavioral effect** today (Guard 3 in
`self-wake.ts` already blocks the autorun regardless of the label). We do the
narrow-correct thing anyway and pin the real defense so a future refactor cannot
silently make the mislabel load-bearing.

## Severity note (why P3, not P2)

The prior audit framed claim 1 as "breaks `on-failure` autorun". That is
**false**. `injectSimulatedTurn` (`src/reactor/self-wake.ts:117-123`) Guard 3
closes on `prior !== "success" && prior !== "uncertain"` — i.e. **both** `"fail"`
AND `"partial"` (and absent) are skipped with `reason: "prior-outcome"`. So
labelling an Esc-Esc cancel as `"fail"` vs `"partial"` produces an identical
not-eligible verdict. `tests/unit/reactor-self-wake.test.ts:236-290` already pins
this (parametrized over `'fail'`, `'partial'`, omitted → all `"prior-outcome"`).
Claim 1 is a semantic/consistency mislabel, not a correctness bug. Claims 2-5 are
minor observability / semantic-label gaps. Bundle severity = P3.

## Problem (ground-truthed 2026-07-09)

1. **Esc-Esc / no-result → hardcoded `"fail"`, bypassing the SSOT classifier.**
   `src/apps/cli/repl/session-loop.ts:832-833`:
   ```ts
   if (out.turnAborted || out.result === undefined) {
     lastTurnOutcome = "fail"
   }
   ```
   The happy path (`:598-602`, `:807-811`) routes through the SSOT classifier
   `lastTurnOutcomeFromAgentOutcome`, which maps `"aborted" → "partial"`
   (`src/reactor/agent-outcome-adapter.ts:24-27`). The abort branch instead
   hardcodes `"fail"`, disagreeing with the SSOT for the exact same terminal
   reason. **No behavioral effect** (Guard 3 blocks either label — see Severity
   note), but it is an inconsistency and a latent trap: if Guard 3 is ever
   loosened to allow `"partial"`, the label silently becomes load-bearing.

2. **Background (Ctrl+B) turn: `lastTurnOutcome` stale.**
   `src/apps/cli/repl/session-loop.ts:825-830` — when `out.backgrounded === true`
   the loop `continue`s to a fresh prompt WITHOUT folding the backgrounded turn's
   eventual outcome into `lastTurnOutcome`. This is a **documented V1 limitation**
   (the in-code comment at :828-829 states the SDK session is SSOT), not an
   accidental drop. Wiring the async bg-completion outcome onto `lastTurnOutcome`
   would be a **race** (a backgrounded turn landing on a LATER interactive
   prompt's `lastTurnOutcome`). Fail-closed (leave unset/"partial") is safer.
   → deferred backlog, not a fix.

3. **`progress_update` AgentEvent not bridged to the session protocol.**
   `progress_update` is a real `AgentEvent` variant (`src/stream/types.ts:158`,
   `:529-541`), rendered to CLI stdout (`src/stream/adapters/stdout.ts:251`,
   `:446`). It is **absent** from the session bridge registry
   `AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGE`
   (`src/host/runtime/internal/session-host-turn-event-bridge.ts:12-20,32-83` —
   7 bridged types, none `progress_update`). Web / IDE consumers on the session
   protocol never receive progress. No capability flag declares the exclusion, so
   the omission is silent (consumer can't distinguish "unsupported" from "no
   progress emitted this turn").

4. **`AgentRun` drops events silently; `droppedEvents` unreachable by consumers.**
   `EventChannel` in `src/sdk/run.ts:47-110` DROP-OLDESTs past the cap and
   increments `this.droppedEvents` (`:64-67`) — but emits **no event/metric** on
   drop, and the returned `AgentRun` (`:153-157`) exposes only
   `[Symbol.asyncIterator]` + `then`. The `AgentRun` interface (`:31`) has no
   `droppedEvents` member. An SDK stream consumer therefore **cannot detect**
   that it received a lossy stream.

5. **`approvalPlaceholderOutcome` reports `reason: "aborted"` while paused.**
   `src/host/runtime/internal/context-binding/approval-support.ts:116-120`:
   ```ts
   export const approvalPlaceholderOutcome = (messages) => ({
     reason: "aborted", turns: 0, messages: [...messages],
   })
   ```
   Returned by `turn-runner.ts:180-184` **together with an `approvalRequest`** —
   the turn is paused awaiting HITL approval, matching scheduler status
   `"awaiting_approval"` (`src/kernel/session/scheduler.ts:208`,
   `src/protocol/session/snapshot.ts:46`). A consumer reading `outcome.reason`
   sees `"aborted"` (terminal, user-cancelled) when the truth is "paused, resume
   pending". `StopReason` (`src/agent/types/agent-outcome.ts:29-38`) has no
   pause/awaiting reason, so the classifier and adapter cannot distinguish.

## Required changes

1. **Route the abort branch through the SSOT classifier (narrow-correct).**
   Replace the hardcoded `lastTurnOutcome = "fail"` at
   `session-loop.ts:833` with a split:
   - `out.turnAborted` → `lastTurnOutcomeFromAgentOutcome({ reason: "aborted" })`
     → `"partial"` (aligns the abort branch with the SSOT the happy path uses).
   - genuine no-result / error (`out.result === undefined` with no abort) →
     keep `"fail"`.
   Do NOT add ad-hoc reachability logic — the fix is purely making the label
   agree with the SSOT classifier. Additive-block-only eligibility (Codex
   heartbeat-automation model, ADR-0453) is preserved.

2. **Background staleness → deferred backlog item (do NOT wire without
   measuring).** Promote the V1 comment (`session-loop.ts:825-830`) to an
   explicit backlog entry: *(feature)* fold backgrounded-turn outcome into
   `lastTurnOutcome`; *(why)* autorun eligibility after a bg turn currently reads
   stale state; *(ROI)* low — bg-turn autorun is a niche path AND naive wiring
   introduces a cross-prompt race. Fail-closed default (leave "partial"/unset)
   stands until measured.

3. **Bridge `progress_update` OR declare exclusion explicitly (fail-loud).**
   Preferred: add a `progress_update` handler to
   `AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGE` plus a matching
   `SessionHostTurnEventType` (render-only, no loop-control authority — mirror
   the `assistant_text.delta` shape). If not bridged, add an explicit capability
   flag in the session protocol declaring `progress_update` unsupported, so the
   consumer can distinguish "unsupported surface" from "none this turn". Baseline:
   Claude Code / Codex both surface tool-progress on their protocol; parity favors
   bridging. Measure-first: default rendering unchanged either way.

4. **Expose `droppedEvents` + emit one drop signal (evidence-driven).**
   - Add a `droppedEvents` getter to the `AgentRun` surface
     (`src/sdk/run.ts:31,153-157`) so a consumer can read the count post-stream.
   - Emit a single `stream.buffer.dropped` signal (AgentEvent or metric) on the
     **first** drop (`EventChannel.push`, `:64-67`) so a live consumer detects
     loss without polling. One-shot on first drop (not per-drop) to avoid a flood.

5. **Add a dedicated pause reason to the closed union.**
   Add `"awaiting_approval"` (or `"paused"`) to `StopReason`
   (`src/agent/types/agent-outcome.ts:29-38`). The exhaustive `switch` in
   `lastTurnOutcomeFromAgentOutcome` (`agent-outcome-adapter.ts:20-32`) then
   **fails to compile** until the new reason is classified (→ `"partial"`, not
   `"fail"`). Change `approvalPlaceholderOutcome` (`approval-support.ts:117`) to
   use the new reason, aligning `outcome.reason` with scheduler status
   `"awaiting_approval"`.

## Acceptance

- **(1)** `session-loop`'s abort branch produces `lastTurnOutcome === "partial"`
  (SSOT-consistent), AND a self-wake regression pins that BOTH `prior="fail"` and
  `prior="partial"` return `reason: "prior-outcome"` — documenting that Guard 3,
  not the label, is the defense (prevents a future refactor from removing Guard 3
  and making the label load-bearing).
- **(2)** Backlog item recorded with (feature)+(why)+(ROI); no default change.
- **(3)** Session protocol either delivers `progress_update` OR exposes an
  explicit capability flag marking it unsupported (consumer can tell which).
- **(4)** An SDK stream consumer can read `run.droppedEvents` AND receives one
  `stream.buffer.dropped` signal after the first drop.
- **(5)** `approvalPlaceholderOutcome().reason` is the dedicated pause reason (not
  `"aborted"`); adapter classifies it to `"partial"`; adding the reason to
  `StopReason` without classifying is a compile error.

## Proof rails (red-on-injection / mutation-style — cite REAL current paths)

- **(1) abort label + Guard-3 pin** —
  - `tests/unit/reactor-self-wake.test.ts:226-290` ALREADY pins the Guard-3
    invariant (`'fail'` / `'partial'` / omitted → `"prior-outcome"`). Keep it as
    the regression anchor; injecting a Guard-3 loosening must turn it red.
  - Add `tests/unit/apps/cli/session-loop-cancel-outcome.test.ts` (new): drive the
    interactive loop with an aborted turn (`out.turnAborted === true`) and assert
    the recorded `lastTurnOutcome === "partial"`. Mutating `:833` back to `"fail"`
    must fail this test. (Behavioral wiring, not a compile assert — mirror the PTY
    / loop harness style of `tests/unit/apps/cli/session-loop-hellgate.test.ts`.)
- **(3) bridge coverage** —
  `tests/unit/host/session-host-turn-event-bridge-hellgate.test.ts` currently
  asserts `BRIDGED_TYPES.length === 7` (`:19`). If bridging `progress_update`,
  update to 8 and add a positive case asserting a `progress_update` AgentEvent maps
  to a non-`undefined` `SessionHostTurnEvent`; if declaring exclusion, add a test
  asserting the capability flag reports it unsupported.
- **(4) drop observability** — new `tests/unit/sdk/run-dropped-events.test.ts`:
  build `makeAgentRun` with `bufferSize: 1`, push N > 1 events without consuming,
  assert (a) `run.droppedEvents === N-1` and (b) exactly one `stream.buffer.dropped`
  signal was observed. Removing the getter / signal must fail. (Note: current
  `tests/unit/trajectory.test.ts` references a DIFFERENT `droppedEvents` — do not
  conflate; add SDK-specific coverage.)
- **(5) closed-union exhaustiveness** — `tests/unit/reactor-*` or a new
  `tests/unit/reactor/agent-outcome-adapter.test.ts`: assert
  `lastTurnOutcomeFromAgentOutcome({ reason: "awaiting_approval" })` returns
  `"partial"`. The compile-error-on-unclassified-reason is enforced by the
  exhaustive `switch` itself (`agent-outcome-adapter.ts:21-31`); the test pins the
  chosen mapping.

```sh
bun test tests/unit/reactor-self-wake.test.ts
bun test tests/unit/host/session-host-turn-event-bridge-hellgate.test.ts
# new:
bun test tests/unit/apps/cli/session-loop-cancel-outcome.test.ts
bun test tests/unit/sdk/run-dropped-events.test.ts
bun test tests/unit/reactor/agent-outcome-adapter.test.ts
```

> NOTE: the prior ticket's proof rails cited
> `tests/unit/reactor/agent-outcome-adapter.test.ts` and
> `tests/unit/sdk/embed.test.ts` — the adapter test **does not exist** (must be
> created), and `embed.test.ts` exists but does not exercise `droppedEvents`.
