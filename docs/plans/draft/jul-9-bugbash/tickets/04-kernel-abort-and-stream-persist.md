# ALBB-04 — Kernel abort settlement + stream-persist outcome decoupling

**Priority:** P1
**Wave:** A
**Depends on:** none
**Owner:** `src/kernel/session/scheduler.ts`
**Status:** confirmed real (2-round audit + fresh ground-truth 2026-07-09; near-zero line drift)

## Goal

Fail-closed cancel semantics on the session protocol: a cooperatively-cancelled
turn must settle through ONE terminal classifier regardless of throw-vs-return,
and event-log persistence failures must never re-classify host-successful work
as `turn.failed`.

## Problem (ground-truthed against current code)

### 1. Cooperative abort silently rides the `turn.completed` arm — REAL

A host `runTurn` that cooperatively cancels returns
`{ outcome: { reason: "aborted", … } }` WITHOUT throwing. `AgentOutcome.reason`
admits `"aborted"` as a first-class `StopReason`
(`src/agent/types/agent-outcome.ts:29-33`), and the agent loop produces it via
`resolveTurnLoopOutcome` → `{ kind: "finish", reason: "aborted" }`
(`src/agent/loop/turn-outcome.ts:64-71`), which the host boundary returns as
`{ outcome }` without a throw (`src/host/runtime/internal/context-binding/turn-runner.ts:172-177`).

The scheduler's success arm only special-cases `"error"`; every other reason —
including `"aborted"` — falls to `onTurnCompleted`
(`src/kernel/session/scheduler.ts:525-547`):

```ts
: result.outcome.reason === "error"
  ? await onTurnErrored({ … })
  : await onTurnCompleted({ … })   // "aborted" lands HERE
```

`onTurnCompleted` emits a `turn.completed` wire event
(`scheduler.ts:249`, `completionEventsForTurn`) with
`outcomeReason: state.lastOutcomeReason ?? "completed"` (`scheduler.ts:250`),
and it set `lastOutcomeReason: args.result.outcome.reason` at `scheduler.ts:287`.

The divergence: the SAME cancel semantics reached by a THROW (mid-flight abort)
route through the catch arm's `isAbort(error) || turnController.signal.aborted`
check to `onTurnAborted` (`scheduler.ts:548-566`), which emits `turn.failed`
(`scheduler.ts:340`) + `lastOutcomeReason: "aborted"` (`scheduler.ts:331`). So an
identical cancellation surfaces as `turn.completed` when the host RETURNS
`aborted` and `turn.failed` when the host THROWS — two entry points, two
terminal wire shapes, for one logical outcome. `TurnCompletedEvent` carries
`outcomeReason: string` (`src/protocol/session/events.ts:52-57`), so a consumer
that filters on `event.type === "turn.completed"` (the natural "did it succeed?"
predicate) counts an aborted turn as success unless it ALSO inspects
`outcomeReason` — a lossy overload.

### 2. `pendingStream` chain: append failure drops events AND flips outcome — REAL

Stream events are appended through a chained promise with NO `.catch`
(`scheduler.ts:511-522`); `grep '\.catch' scheduler.ts` → none.

```ts
onEvent: (event) => {
  pendingStream = pendingStream.then(async () => {
    const streamed = await emitTurnStreamEvent({ … })   // awaits eventLog.append
    streamState = streamed.state
    streamedEvents.push(streamed.emitted)
  })
},
```

`emitTurnStreamEvent` → `appendEvents` → `await eventLog.append(event)` with no
swallow (`scheduler.ts:102-107`, `scheduler.ts:459`). Two coupled failures:

- **2a. Silent drop:** once one `.then` body rejects, every LATER chained body
  is skipped — subsequent stream events are silently lost from the event log.
- **2b. Outcome flip (fail-open→fail-loud misclassification):** the rejection
  propagates to `await pendingStream` in the success arm (`scheduler.ts:524`)
  and the catch arm's own `await pendingStream` (`scheduler.ts:549`), so a
  persistence-only failure throws into `catch`, is NOT an `isAbort`, and
  routes to `onTurnFailed` (`scheduler.ts:560`) → `status: "failed"` even though
  the host RETURNED success.

This is **asymmetric** with the sibling `onCommitted` sink, which already
swallows subscriber throws into `observerErrorSink` (`scheduler.ts:90-100`,
`notifyCommitted`) precisely so a persistence/observer failure stays diagnostic
and never redefines terminal classification. The `eventLog.append` path has no
such isolation.

### 3. Cancel fast-path returns `{ state, events: [] }` — REAL, intended (P2 doc)

`turn.cancel` against a live turn aborts the controller and returns the PRE-abort
`state` with `events: []` (`scheduler.ts:641-646`); the authoritative terminal
transition is emitted by the running turn's own settle (`onTurnAborted`). This is
documented at `scheduler.ts:627-640`. Keep as intended; only worth a one-line
note that the echo is deliberately empty (the live turn owns the terminal event).

## Required changes (fail-closed, single-classifier)

1. **Terminal-classification SSOT.** Extract one predicate — e.g.
   `classifyTerminal({ outcome, error, aborted })` → `"aborted" | "error" | "completed"`
   — that BOTH the success arm (`scheduler.ts:525-547`) and the catch arm
   (`scheduler.ts:548-566`) call, so a cancel resolves to the same settlement
   whether the host RETURNED `outcome.reason==="aborted"` or THREW an abort.
   Structurally eliminate the two-entry-point divergence rather than adding one
   `outcome.reason==='aborted'` branch to the success arm (patching one branch
   leaves the two paths free to drift again).

2. **Dedicated cancel terminal wire type (absorb Codex / Claude-Code session
   protocol norm).** The protocol today has only `turn.completed` / `turn.failed`
   / `turn.started` (`src/protocol/session/events.ts:184-225`,
   `SESSION_EVENT_TYPES`) — no cancelled variant, so the current abort-via-throw
   path already OVERLOADS `turn.failed` for cancel. Codex/Claude-Code session
   protocols give a cancelled turn its OWN terminal type distinct from both
   success and error. Add `turn.aborted` (or `turn.cancelled`) to
   `events.ts` + `SESSION_EVENT_TYPES` and route BOTH `onTurnAborted` and the
   return-`aborted` case to it, so no downstream consumer conflates cancel with
   success (`turn.completed`) or with error (`turn.failed`). Reducer/read-model
   consumers of `SESSION_EVENT_TYPES` must be swept for exhaustiveness.

3. **Persistence decoupling (symmetric with `notifyCommitted`).** Wrap the
   `pendingStream` chain body (`scheduler.ts:512-522`) in per-event try/catch:
   on `eventLog.append` rejection, route the error to a no-throw sink (reuse the
   `observerErrorSink` pattern at `scheduler.ts:90-100`, or a dedicated
   append-error sink) and record a failure counter, then CONTINUE the chain so a
   later stream event still attempts its append. One append rejection must not
   (a) poison the chain / drop subsequent events, nor (b) reclassify a
   host-successful turn to `turn.failed`. Append and observer failures are then
   handled symmetrically: both diagnostic, neither redefines terminal outcome.

4. **(P2 doc)** One-line note at `scheduler.ts:641-646` that the empty
   `events: []` echo is intentional — the live turn owns the terminal event.

No arbitrary thresholds; the only new observable is a monotonic
`append_failed` counter/metric (measure-first — its value is diagnostic, not a
gate).

## Acceptance

- A host that RETURNS `outcome.reason==="aborted"` and a host that THROWS an
  abort settle to the SAME terminal classification (same `lastOutcomeReason`
  AND same emitted terminal event type — the dedicated cancel type, distinct
  from both `turn.completed` and `turn.failed`).
- An `eventLog.append` rejection mid-stream on a host-successful turn keeps
  `status: "idle"` (NOT `failed`), does NOT drop later stream events (a later
  append is still ATTEMPTED), and increments the append-failure counter.
- `SESSION_EVENT_TYPES` includes the new cancel terminal type and all
  reducers/read-models over it stay exhaustive (typecheck green).

## Proof rails (red-on-injection, not vacuous compile-asserts)

Extend `src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts`. The
existing `cx-3` test (`kernel-cancel.hellgate.test.ts:162-231`) already drives a
return-`"aborted"` host (lines 192-199) but asserts ONLY
`result.state.lastOutcomeReason === "aborted"` (line 230) — it passes on TODAY's
buggy `turn.completed` route. It must be strengthened to pin the WIRE EVENT.

- **(a) Cancel-terminal-type pin.** For the return-`"aborted"` host, assert the
  EMITTED event type list (`result.events.map(e => e.type)`) contains the chosen
  cancel terminal type and does NOT contain `"turn.completed"`. Add a paired
  case for the abort-via-THROW host (mirror the mid-flight cancel in `cx-2`,
  lines 91-160) asserting the SAME terminal type — proving the single-classifier
  convergence. Mutation-check: reverting the success-arm routing (letting
  `aborted` fall to `onTurnCompleted`) must turn (a) RED.

- **(b) Append-failure isolation.** Mirror the existing `cx-6` onCommitted-swallow
  test (`kernel-cancel.hellgate.test.ts:425-473`) for the `eventLog.append`
  sink: inject an `eventLog` whose `append` REJECTS on the Nth call (mid-stream),
  drive a host that emits ≥2 stream events then returns
  `outcome.reason==="completed"`, and assert (i) `result.state.status === "idle"`
  and the terminal event is `turn.completed`, NOT `turn.failed`; (ii) a LATER
  stream event still ATTEMPTED its append (append call count advanced past the
  rejecting index / failure counter incremented) — proving the chain was not
  poisoned. Mutation-check: removing the per-event try/catch must turn (b) RED
  (turn flips to `failed` and/or the later append is never attempted).

```sh
bun test src/kernel/session/__tests__/kernel-cancel.hellgate.test.ts
bun test tests/unit/kernel/kernel-scheduler.test.ts
# each new assertion must go RED when its fix is reverted (mutation-check)
```
