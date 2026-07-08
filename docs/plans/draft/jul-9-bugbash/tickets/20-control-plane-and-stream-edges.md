# ALBB-20 — Control plane and stream edge cases

**Priority:** P2  
**Wave:** D  
**Depends on:** none  
**Owner:** multiple loop edge modules

## Goal

Bundle P2 control/stream fixes under ONE unifying invariant absorbed from the
Claude Code / Codex agent loops:

> **Every degrade / swallow point in the loop is OBSERVABLE** — via the stream
> sink OR a typed outcome OR a `logger.warn`. No silent `clear()`, no bare
> `catch {}`, no half-wired timeout that falls through to un-wrapped `src`.

Ground-truthed 2026-07-09 against current source (line numbers verified live,
not trusted from the audit sweep). **11 of the 15 swept items are genuine,
owner-fix-sound defects quoted below. 4 are already-defended / already-fixed and
are EXPLICITLY DROPPED from this PR** to keep the change surface honest (see
"Dropped" table).

The unifying pattern across the real ones is **sibling asymmetry**: within the
SAME module, one provider hook wraps-and-emits on throw while its sibling runs
the injected callback bare. The fix MIRRORS the existing emit-on-throw pattern —
zero new heuristics, just parity.

## Scope — REAL defects (verified live)

| # | Site (verified path:line) | Defect (current code) | Fix |
|---|---------------------------|-----------------------|-----|
| 1 | `src/agent/loop/plan-exit-wire.ts:64-66` | `rejected` branch: `cfg.planStore?.clear(); return` — zero stream emit, zero hook reminder, while `approved` (32-62) emits `plan_snapshot`/`mode_changed` + pushes `approvedPlanReminder`, and requested-changes (68-71) pushes `requestedChangesReminder`. | Emit a `mode_changed`/`plan_snapshot`-style event + push an operator reminder BEFORE `clear()`, mirroring the approved branch. |
| 2 | `src/agent/loop/turn-iteration.ts:24-35` (called uncaught at `:195`) | `applySteerBarrierMessages` does `await cfg.steerBarrier()` with NO try/catch; a throwing steer barrier crashes the whole turn. Sibling `injectFocusChainMessage` (`:154-176`) wraps + emits `focus-chain inject failed`. | Wrap in try/catch, emit a `{type:"error"}` mirroring focus-chain. Use the shared `runObservable` helper (see SOTA rail). |
| 4 | `src/agent/streaming-boomerang/default-streamer.ts:173-179` | Terminal error push swallowed: `channel.pushTerminal({kind:"error",…}).catch(() => {})` — a late-push rejection is fully silent. (`channel.close()` in the `finally` at `:181` already fires, so channel-close is NOT the gap; the SILENT push-failure is.) | Replace bare `.catch(()=>{})` with `.catch((e) => logger.warn(...))` so a terminal-push failure is observable once. |
| 5 | `src/agent/stream-timeout/default-watchdog.ts:96-98,120,175,215` | Graceful degrade path: `reactToError` returns `"degrade"` → `pullOne` returns `{kind:"return"}` → `iterateOnce` returns → generator `return`s at `:215`, ending the stream with NO event. Slice is deliberately plane-clean (imports `./port`,`./types` only, header `:8-9`). | **Fix at the CALLER, not the slice.** `stream-consume` owns `config.stream`; have it detect the graceful degrade-termination and emit a non-fatal `{type:"error"}` / idle-degrade notice. Do NOT break the watchdog's `./port,./types` import boundary. |
| 6 | `src/agent/loop/stream-consume.ts:74-77` | AND-gate: `streamWatchdog !== undefined && streamTimeoutPolicy !== undefined ? wrap : src`. If EXACTLY ONE is set, the timeout silently falls through to un-wrapped `src` — a misconfigured timeout never fires and is invisible. | Fail-loud: `logger.warn` (or stream error) when exactly one of the two is set. A half-configured timeout must never silently no-op. |
| 8 | `src/agent/streaming-dispatch.ts:174-188` (outer) + `src/agent/tool-input-streaming.ts:58-85` (per-callback) | DOUBLE swallow: `fireToolInput` wraps the seam call in `try { … } catch {}` (`:184`) AND every per-callback (`onInputStart`/`onInputDelta`/`onInputAvailable`) has its own bare `catch {}` (`:60,71,83`). A faulty third-party tool callback is invisible at BOTH layers. | Keep the defensive swallow, but add ONE `logger.warn`/stream emit at the OUTER seam (`fireToolInput`) so a faulty callback is observable exactly once. |
| 9 | `src/agent/loop/turn-loop.ts:104-105` | Turn-observability flush failure: `catch (flushErr) { logger.warn(...) }` — warn-only, no stream event; a UI watching the sink never learns the flush dropped telemetry. | Add a stream emit (non-fatal) alongside the warn. |
| 10 | `src/agent/loop/session-hooks.ts:31-37` | `findTrailingUserMessageIndex` picks the last `role === "user"` message with NO synthetic filter. A synthetic user message appended at the tail (`makeSyntheticUserMessage` focus-chain / turn-budget reminder, `src/agent/synthetic-user.ts:12`) is misread as the operator's real prompt and fed to the `user_prompt_submit` hook. | Skip synthetic messages using the EXISTING `isSyntheticUserMessage` (`src/agent/synthetic-user.ts:21`) when scanning for the trailing user prompt. |
| 12 | `src/agent/loop/context-assembler.ts:392-398` | `config.turnContextMutator(turn, turnInput)` called UNCAUGHT; a throwing mutator crashes context assembly. Sibling `injectIdeContext` in the SAME file (`:209-228`) wraps + emits `ide-context provider failed`. | Wrap + emit-on-throw mirroring `injectIdeContext`; on throw, fall back to un-mutated `turnInput`. Use `runObservable`. |
| 13 | `src/agent/compaction.ts:252-272` (via `reactiveCompact` `:340-355`, called from `src/agent/loop/recovery-executor.ts:125`) | `summarizeWith` does `llm.stream({messages,system,tools:[]})` with NO `signal`, so the reactive-compaction summarizer LLM call is non-interruptible on Ctrl+C/deadline. `LLMStreamRequest.signal?: AbortSignal` EXISTS (`src/llm/types.ts:330`) and `config.signal` is in scope at the caller (`recovery-executor.ts:106-125` references `config.compaction`/`config.llm`). | Thread `config.signal` through `recovery-executor` → `reactiveCompact` → `summarizeWith` into `llm.stream({… , signal})`. Also cover the `dropOldestSalvage` path (`recovery-executor.ts:108`). |
| 14 | `src/agent/loop/same-turn-engine.ts:26,35-52` | Abort is checked at `:26` (BEFORE `prepareTurnContext`), but `prepareTurnContext` (`:35-50`) awaits provider work (`ideContextProvider.snapshot`, effort classifier). There is NO re-check of `config.signal.aborted` between prep completion (`:50`) and `streamConsume` (`:52`) — an abort DURING prep only surfaces after a full stream turn runs. | Re-check `config.signal.aborted` immediately after `prepareTurnContext` returns; on abort, `classifyTurnAbort` without entering `streamConsume`. |

## Scope — DROPPED (already defended / already-fixed — do NOT include in PR)

| Swept claim | Reality (verified) |
|-------------|--------------------|
| `control-poll` error → silent `{kind:none}` | NOT SILENT. `pollConversationAction` emits `conversationActionPort.next failed` (`src/agent/loop/control-poll.ts:163`) BEFORE returning `{kind:"none"}` (`:164`). Every catch in the file already `stream.emit`s (`:103,131,163,175,197`). |
| `handleSkillScope` throw → dispatch fail | Escalation card is emitted via `onEscalationRequested` (`src/agent/stream-callbacks.ts:305-315`) BEFORE `onConfirm` resolves, plus a `skill_scope_decision` timeline item (`:327`). The approval-rethrow is structural. Not a swallow. |
| Session lifecycle hook throws | `HookBus.runHandler` is the NO-THROW boundary: `catch (e) { this.logger?.error("hook.handler.error", …) }` (`src/agent/hooks.ts:762-766`). A handler throw cannot escape `hooks.emit(...)` in `session-lifecycle.ts`. |
| Closeout critic noop without reviewer | ALREADY WARNS ONCE. `wireCloseoutCritic` guards on `warnedCloseoutCriticNoReviewer` and `logger.warn`s when the knob is ON but no reviewer subagent exists (`src/agent/optional-ports.ts:452-455`). |

## Required changes (SOTA++)

Fail-closed-by-default where the degrade hides a real misconfig; observable
everywhere else. Absorb the Claude Code / Codex loop invariant "no silent
degrade in the agent loop".

1. **Shared boundary helper.** Add `runObservable(fn, stream, label)` (no-throw +
   emit-on-throw) and apply it at the two uncaught sibling-asymmetry sites —
   #2 `steerBarrier` and #12 `turnContextMutator` — by mirroring the EXACT
   existing emit-on-throw shape already in those files (`injectFocusChainMessage`,
   `injectIdeContext`). Zero new heuristics; parity only.
2. **Plan-exit rejected (#1).** Emit a `mode_changed`/`plan_snapshot`-style event
   + push an operator reminder before `clear()`, mirroring the approved /
   requested-changes branches.
3. **Half-wired timeout (#6) — fail-loud.** Replace the AND-gate with a
   `logger.warn` (or stream error) when EXACTLY ONE of `streamWatchdog` /
   `streamTimeoutPolicy` is set. A misconfigured timeout must never fall through
   to un-wrapped `src` invisibly.
4. **Watchdog degrade (#5) — re-scope to caller.** `stream-consume` detects the
   graceful degrade-termination and emits a non-fatal idle-degrade event. Keep
   the watchdog slice plane-clean (do NOT add sibling imports).
5. **Tool-input double swallow (#8).** Keep the defensive swallows, add ONE
   `logger.warn`/emit at the OUTER `fireToolInput` seam.
6. **Compaction interruptibility (#13).** Thread `config.signal` end-to-end into
   `llm.stream({…, signal})` so the summarizer call is cancellable. No new knob —
   `signal` absent stays byte-identical (`src/llm/types.ts:322-330`).
7. Apply the remaining one-liners (#4 warn-on-push-fail, #9 flush emit,
   #10 synthetic filter, #14 post-prep abort recheck) per the table above.

**Measure-first:** none of these change agent decisions or model prompts —
they are pure observability / interruptibility. All are byte-identical on the
happy path, so no efficacy A/B is gated; land under normal red-on-injection
review.

## Proof rails — red-on-injection (behavioral, NOT vacuous compile-assert)

Each item gets a test that FORCE-THROWS / half-wires and asserts the exact
stream event or logged warning fires. The test MUST go red if the emit is
deleted (mutation-style). Colocate next to the module or in the existing suite
below (several modules currently have NO colocated test — create one).

Verified current test locations (the swept `tests/unit/streaming-boomerang/`
and `tests/unit/stream-timeout/` DIRECTORIES do not exist — real paths):

- `tests/unit/agent/loop/` — `session-hooks.test.ts` exists (extend for #10);
  ADD `plan-exit-wire.test.ts` (#1), `turn-iteration.test.ts` (#2),
  `stream-consume.test.ts` (#5,#6), `context-assembler.test.ts` (#12),
  `same-turn-engine.test.ts` (#14), `turn-loop.test.ts` (#9).
- `tests/unit/streaming-dispatch.test.ts` + `src/agent/streaming-dispatch.test.ts`
  — extend for #8 (inject a callback that throws; assert one warn).
- `tests/unit/stream-timeout.test.ts`, `tests/unit/stream-timeout-hellgate.test.ts`
  — #5 caller-emit (drive via stream-consume, not the plane-clean slice).
- `tests/unit/agent/streaming-boomerang-hellgate.test.ts` — #4 push-fail warn.
- `tests/unit/compaction.test.ts` — #13: pass an already-aborted signal, assert
  `llm.stream` receives it and the summarizer aborts.

Red-on-injection contract per test: assert `stream.emit` / `logger.warn` fired
with the specific label; a paired "delete the emit ⇒ test fails" mutation check.

```sh
bun test tests/unit/agent/loop/
bun test tests/unit/streaming-dispatch.test.ts src/agent/streaming-dispatch.test.ts
bun test tests/unit/stream-timeout.test.ts tests/unit/stream-timeout-hellgate.test.ts
bun test tests/unit/agent/streaming-boomerang-hellgate.test.ts
bun test tests/unit/compaction.test.ts
```

## Acceptance

- Each REAL item (#1,2,4,5,6,8,9,10,12,13,14) has a red-on-injection unit test
  that fails if the emit/warn/signal is removed.
- No new empty `catch {}` without a `logger.warn`/`stream.emit` or a comment
  referencing this ticket. Enforce as a grep gate in CI over the touched files.
- The 4 DROPPED claims are NOT touched (already defended).
