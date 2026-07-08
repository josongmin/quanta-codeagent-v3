# ALBB-06 — Interrupted-turn capture on signal abort + richer resume payload

**Priority:** P1
**Wave:** B
**Depends on:** none
**Owner:** `src/agent/loop/turn-iteration.ts`, `src/agent/loop/turn-outcome.ts`, `src/agent/interrupted-turn.ts`

**Verdict:** keep (2 audit rounds + fresh ground-truth read). Canonical ticket
for the interrupted-turn-capture gap — no merge target.

## Goal

Make `/resume` restore a turn cancelled by the MOST COMMON gesture — Ctrl+C /
Esc-Esc, i.e. a plain `AbortController.abort()` on the threaded signal — not only
the conversation-action `/cancel` verb. Additionally, absorb the Claude Code /
Codex baseline of persisting in-flight tool_use state so resume can re-anchor a
mid-tool-call turn rather than silently dropping it.

## Problem

`interruptedTurnBuffer.capture` fires from EXACTLY ONE site in `src/`, and it is
gated on the conversation-action `/cancel` verb — `turn-iteration.ts:81-83`,
inside `syncQueuedTurnInputs`:

```ts
const actionOutcome = await pollConversationAction(args.cfg, args.taskRegistry)
if (actionOutcome.kind === "finish_aborted") {
  args.cfg.interruptedTurnBuffer?.capture(
    captureInterruptedTurn(args.wm.snapshot(), actionOutcome.reason, Date.now()),
  )
  return "aborted"
}
```

The two `AbortSignal`-driven abort exits — the ones the REPL's Ctrl+C / Esc-Esc
actually hit — return `"aborted"` with **no capture**:

1. `prepareTurnIteration` at `turn-iteration.ts:192` (turn boundary):
   ```ts
   if (args.cfg.signal.aborted) return "aborted"
   ```
   Silent: no `interruptedTurnBuffer?.capture` before the early return.

2. `prepareTurnIteration` at `turn-iteration.ts:198` (the queued-inputs relay,
   which forwards the `finish_aborted` case above but ALSO the plain
   `signal.aborted` path when it re-enters):
   ```ts
   const queuedInputs = await syncQueuedTurnInputs(args)
   if (queuedInputs === "aborted") return "aborted"
   ```

3. Mid-turn `TurnResult.kind === "aborted"` in `turn-outcome.ts:64-71`:
   ```ts
   if (args.result.kind === "aborted") {
     clearQueuedPlanLifecycle(args)
     return {
       kind: "finish",
       reason: "aborted",
       turns: args.turn - 1,
       stopCategory: interruptedCategory("user"),
     }
   }
   ```
   No buffer touch. And `classifyTurnAbort` (`turn-gate.ts:34-40`) DETERMINISTICALLY
   yields `{ kind: "aborted" }` for the interactive path, because the REPL wires
   **no `SubagentTurnGate`** (`gate?.wasInterrupted()` is `undefined`), so this is
   the exact branch a keystroke cancel lands on.

The REPL wiring proves the trigger: `src/apps/cli/repl/turn-runner.ts:134-135`
routes both cancel gestures through plain `AbortController.abort()` on the
threaded signal — never `pollConversationAction`:

```ts
onCancel: () => turnAbort.abort(),
onAbort: () => outerAbort.abort(),
```

Net effect: a Ctrl+C / Esc-Esc mid-turn is **silently unrecoverable** — the
partial user work is lost and `/resume` has nothing in the buffer to restore.

**Payload gap (secondary):** even on the one path that DOES capture, the resume
payload is text-only. `InterruptedTurn` (`interrupted-turn.ts:20-29`) has no
tool_use / thinking field, and `textOf` (`interrupted-turn.ts:32-36`) filters to
`type === "text"` blocks only:

```ts
const textOf = (m: Message): string =>
  m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
```

So a turn interrupted mid-tool-call resumes with the model unaware it had a call
in flight — it may silently drop or double-issue it.

## Required changes

**Fail-closed by default, uniform decision (no thresholds).** The only new
policy is "capture on EVERY abort exit" — a single uniform rule, not a heuristic.

1. **Single shared helper, one call shape.** Introduce
   `captureAbortedTurn(cfg, wm, reason)` that mirrors the existing
   `turn-iteration.ts:81` call exactly (`cfg.interruptedTurnBuffer?.capture(
   captureInterruptedTurn(wm.snapshot(), reason, Date.now()))`). Wire it at all
   THREE abort exits so `/cancel` and the two new signal paths share ONE code
   path — no logic drift:
   - `turn-iteration.ts:192` (before `return "aborted"` on `signal.aborted`)
   - `turn-iteration.ts:198` (before `return "aborted"` on `queuedInputs === "aborted"`)
   - `turn-outcome.ts:64` (before the `finish`/`aborted` return)

   Default-OFF preserved: no `interruptedTurnBuffer` wired ⇒ `?.capture` is a
   no-op ⇒ byte-identical. The `/cancel` site is refactored to call the same
   helper (paired-control: its behavior must stay byte-identical).

2. **Distinct reason strings per trigger** so telemetry/tests can prove WHICH
   path fired: `signal_abort` (prep boundary), `turn_result_abort`
   (mid-turn `TurnResult`), and the existing `conversation_cancel`
   (`actionOutcome.reason`). No merged/ambiguous reason.

3. **Absorb competitor baseline (Claude Code / Codex).** Both persist in-flight
   tool_use state on interrupt so resume can re-anchor a mid-tool-call turn.
   Extend `InterruptedTurn` with an OPTIONAL typed field
   `inFlightTools?: readonly { id: string; name: string }[]` — **ids/names only,
   NO args** (avoid payload bloat / secret leakage), derived from the last
   assistant message's `tool_use` blocks. Keep `textOf` text-only for
   `partialAssistantText`; add the tool summary as a TYPED field, not a string.
   `buildResumeMessage` appends a "you had started tool X (id …); complete or
   re-issue it" note so the model re-anchors rather than silently dropping.

4. **Align docs.** `§11.5` (`interrupted-turn.ts:1-15`) currently claims capture
   happens on "`interrupt` mode (or `/cancel`)"; update the header + any CLI docs
   to reflect that ALL abort exits (signal + conversation-action) now capture.

## Acceptance

- `signal.abort()` mid-stream with a buffer wired ⇒ `/resume` restores
  `partialAssistantText` AND the in-flight tool summary.
- Conversation-cancel path byte-identical (paired regression).
- Default-OFF (no buffer wired) ⇒ abort still finishes clean, no capture, no crash.
- `interrupted-turn-hellgate` + `crash-resume-hellgate` extended to cover the
  broadened trigger flowing through to `SessionMeta.interruptedTurn` persistence
  (crash-resume rides the same buffer via `markSessionInterrupted`,
  `src/session/crash-resume.ts:128`).

## Proof rails

Red-on-injection / behavioral (NOT a compile assert):

```sh
# existing regression backstops
bun test tests/unit/interrupted-turn-hellgate.test.ts
bun test tests/integration/crash-resume-hellgate.test.ts
bun test tests/integration/agent-abort.test.ts

# NEW — tests/integration/interrupted-turn-signal-abort.test.ts
#  (a) fire signal.abort() mid-stream with a buffer wired; assert /resume
#      restores partialAssistantText AND inFlightTools summary.
#      RED-ON-INJECTION: stub captureAbortedTurn to a no-op ⇒ this test MUST fail.
#  (b) PAIRED-CONTROL: the conversation-cancel (/cancel) path is byte-identical
#      (same captured buffer shape as before this change).
#  (c) DEFAULT-OFF: no buffer wired ⇒ abort finishes clean, buffer.has()===false,
#      no throw.
#  Assert per-path reason strings: signal_abort / turn_result_abort /
#  conversation_cancel are distinguishable in the captured InterruptedTurn.
```

Extend `crash-resume-hellgate` to prove: a `signal_abort` capture (path (a))
propagates to `SessionMeta.interruptedTurn` on the persisted snapshot
(fresh-readback via `loadSessionById`), and mutating the new capture site to a
no-op turns that assertion red.
