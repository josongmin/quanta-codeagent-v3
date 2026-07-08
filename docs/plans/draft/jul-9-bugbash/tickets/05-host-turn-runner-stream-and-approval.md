# ALBB-05 — Host turn-runner stream: NO-THROW base-emit parity

**Priority:** P2 (robustness / defensive-coding parity — no observed data loss)
**Wave:** B
**Depends on:** none (ALBB-04 scheduler path is unrelated after re-audit)
**Owner:** `src/host/runtime/internal/context-binding/turn-runner.ts`
**Scope:** claim 1 ONLY. Claims 2 & 3 dropped after ground-truth (see "Dropped claims").

## Goal

Make the host→loop stream tap fail-silent with the SAME contract already proven
in our own codebase: `wireAgentStateTap` / `wireItemLifecycleStream`
(`src/agent/optional-ports.ts`). A throwing observer (host `onEvent` bridge or
the item projector) must NEVER suppress the base agent-stream emit — the base
wire (stdout / jsonl / every downstream consumer) is the source of truth and
must fire first, verbatim, unconditionally.

## Problem (verified 2026-07-09)

`createTurnStreamPort.emit` runs the observer fan-out BEFORE the base emit, with
**no guard** — `src/host/runtime/internal/context-binding/turn-runner.ts:48-62`:

```ts
emit(event: AgentEvent): void {
  const errorMessage = extractTurnErrorMessage(event)
  if (errorMessage !== undefined) lastErrorMessage = errorMessage
  const sessionEvent = toSessionHostTurnEvent(event)
  if (sessionEvent !== undefined) args.onEvent?.(sessionEvent)   // ← may throw
  if (itemProjector !== undefined) {
    for (const item of itemProjector.project(event)) {           // ← may throw
      args.onEvent?.({ type: "item.stream", item })              // ← may throw
    }
  }
  args.baseStream.emit(event)                                    // ← NEVER REACHED if above throws
}
```

Fail-open / silent path: any **synchronous** throw from `args.onEvent` or
`ItemStreamProjector.project` propagates out of `emit`, so `args.baseStream.emit(event)`
(line 61) never runs — that event is silently dropped from stdout/jsonl and every
downstream consumer, and the throw unwinds into the loop's emit call site. This
is reachable today via the synchronous `itemProjector.project` path (line 57)
and any synchronous `onEvent` consumer the kernel/host wires in.

### Contrast — the proven sibling contract (competitor-baseline WITHIN our repo)

`src/agent/optional-ports.ts:297-312` (`wireAgentStateTap`) does the opposite,
and documents WHY:

```ts
emit(event: AgentEvent): void {
  // Base emit FIRST + verbatim — every existing consumer is byte-identical.
  source.emit(event)
  const observation = projectAgentEventToItemStreamObservationsGated(event, env)
  if (observation === null) return
  try {
    sink.capture(observation)
  } catch {
    // A throwing sink must never break the base emit (already done above)
    // or crash the turn — observation-only, fail-silent.
  }
}
```

Same for `wireItemLifecycleStream` (`optional-ports.ts:323-333`) and
`wireItemStreamTap`. turn-runner is the lone divergent tap: base-emit-LAST +
unguarded. This is a defensive-coding **parity gap**, not a hypothetical.

## Required changes (mirror `wireAgentStateTap` EXACTLY)

In `createTurnStreamPort.emit`
(`src/host/runtime/internal/context-binding/turn-runner.ts:48-62`):

1. Keep `lastErrorMessage` capture SYNCHRONOUS and BEFORE the guarded block —
   it reads off the raw `event`, is infallible, and is consumed by
   `getLastErrorMessage()` on the success path (line 146). It must not be
   swallowed.
2. Call `args.baseStream.emit(event)` **FIRST + verbatim** — the base wire is
   the SSOT; every existing consumer stays byte-identical and the emit is
   unconditional.
3. Run the observer fan-out (`onEvent` bridge + `itemProjector.project` loop)
   AFTER the base emit, inside a **single `try { … } catch {}`** that swallows
   (observation-only; must never break the base wire or crash the turn). Mirror
   the exact `optional-ports.ts` comment so the intent survives future edits.

No new knob, no config, byte-identical for the non-throwing path (the common
case). This is pure robustness — do NOT gate it behind a flag.

Target shape:

```ts
emit(event: AgentEvent): void {
  const errorMessage = extractTurnErrorMessage(event)
  if (errorMessage !== undefined) lastErrorMessage = errorMessage
  // Base emit FIRST + verbatim — every existing consumer is byte-identical
  // (mirrors wireAgentStateTap in src/agent/optional-ports.ts).
  args.baseStream.emit(event)
  try {
    const sessionEvent = toSessionHostTurnEvent(event)
    if (sessionEvent !== undefined) args.onEvent?.(sessionEvent)
    if (itemProjector !== undefined) {
      for (const item of itemProjector.project(event)) {
        args.onEvent?.({ type: "item.stream", item })
      }
    }
  } catch {
    // A throwing observer must never break the base emit (already done above)
    // or crash the turn — session-bridge fan-out is observation-only, fail-silent.
  }
}
```

## Acceptance

- A throwing `onEvent` consumer does NOT suppress the base emit for that event
  (stdout/jsonl still receives it) and does NOT unwind into the loop.
- A throwing `ItemStreamProjector.project` (DI-injected) does NOT suppress the
  base emit.
- Non-throwing path is byte-identical: base receives every event, in order,
  exactly once (no double-emit), and `getLastErrorMessage()` still reflects the
  last `error` event.

## Proof rails (red-on-injection — must fail if base-emit-last is reintroduced)

Baseline to clone: `tests/unit/agent-state-tap-byte-identical-hellgate.test.ts`
already exercises this exact contract for `wireAgentStateTap` (base emit reaches
the spy verbatim + ONCE even with a throwing sink). Mirror its structure.

New: `tests/unit/host/turn-stream-port-no-throw.test.ts`

- (a) **red-on-injection:** build `createTurnStreamPort` with a capturing base
  sink (fresh-readback array) + an `onEvent` that THROWS on a chosen event, and
  (separately) a DI-injected `ItemStreamProjector.project` that THROWS. Assert
  the capturing base sink STILL received EVERY event, in order, exactly once.
  This test goes RED if someone reverts to base-emit-LAST or drops the try/catch.
- (b) **paired-control (byte-identical):** identical harness with a NON-throwing
  `onEvent`; assert base passthrough is byte-identical (same events, same order,
  no duplicates) AND `getLastErrorMessage()` returns the last error event's
  message — proving the fix is passthrough-neutral and preserves error capture.
- (c) **parity assertion:** assert turn-runner's emit ordering is base-FIRST,
  matching `wireAgentStateTap` — a drift guard so the two taps can't diverge
  again (structural, but backed by the behavioral (a)/(b) teeth, not vacuous).

```sh
bun test tests/unit/host/turn-stream-port-no-throw.test.ts
bun test tests/unit/agent-state-tap-byte-identical-hellgate.test.ts   # sibling baseline
```

## Dropped claims (ground-truthed 2026-07-09 — NOT bugs)

- **Claim 2 (approval catch skips `persistTurn`):** `turn-runner.ts:178-187`
  returns `approvalPlaceholderOutcome(args.history)` + `messages: [...args.history]`
  on `isRuntimeApprovalRequiredError`, without calling `persistTurn`. But the
  placeholder commits NOTHING new — the pre-turn history is already persisted
  and the approval delta is on the event log via the scheduler. No data loss;
  P3-optional at best. **Dropped.**
- **Claim 3 (streaming text cleared at pause):** `scheduler.ts:211` (and 285,
  412) wraps `summarizeTranscript(args.result.messages)` in
  `clearStreamingAssistantText` (`scheduler.ts:125-128`). Partial deltas are
  already appended to the event log as live delta events; the transcript summary
  intentionally drops the volatile in-flight buffer because approval is
  abandon-and-rerun (the next run re-streams). The R1 "data loss" framing is
  wrong. **Dropped.**

## Non-overlap

No overlapping ticket owns `createTurnStreamPort`. This file is canonical for
the base-emit-first / fail-silent parity fix.
