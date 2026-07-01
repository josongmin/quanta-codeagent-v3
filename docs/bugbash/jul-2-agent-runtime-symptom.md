# Agent Runtime Loop — Final Action Items (2026-07-02)

Review rule: kept only items that are still confirmed in current code and are either
1) correctness/user-visible bugs now, or 2) safety blockers before enabling a gated path.
Dropped LOW hardening, refuted items, and conditional policy questions.

## Do now

1. **Fix interrupted resume prompt capture**
   - Evidence: `captureInterruptedTurn` takes the last `role:"user"` message even when it is a pure
     `tool_result` append from `turn-outcome.ts`; `buildResumeMessage` then emits an empty
     `"The task was:\n"` body after a tools turn.
   - Refs: `src/agent/interrupted-turn.ts:44-66`, `src/agent/interrupted-turn.ts:105-111`,
     `src/agent/loop/turn-outcome.ts:79-81`
   - Fix: walk backward to the last non-empty user text, or persist the originating prompt for the
     logical turn explicitly.

2. **Unify terminal classification across completed / budget / pause / interrupt**
   - Evidence:
     - `resolveTurnLoopOutcome` checks `budgetMeter.checkExhausted()` before the `completed` branch, so
       a successful last turn can finish as `budget_exhausted`.
     - `SessionApprovalRequiredError` is rethrown from `stream-consume.ts` with sampling status
       `"error"`, and `turn-loop.ts` leaves `flushKind="error"` / `turnSpanStatus="error"`.
     - park -> settle finishes with `interruptedCategory("user")` even when the cause was a
       subagent wake, not a user interrupt.
   - Refs: `src/agent/loop/turn-outcome.ts:60-76`, `src/agent/loop/stream-consume.ts:225-226`,
     `src/agent/loop/turn-loop.ts:25-26`, `src/agent/loop/turn-loop.ts:42-53`,
     `src/agent/loop/turn-loop.ts:132-135`
   - Fix: let `completed` win over post-turn budget exhaustion; map approval-required to a non-error
     pause state; carry interrupt cause through the park/settle path.

3. **Make tool visibility and dispatch scope agree when skill scoping is off**
   - Evidence: `stream-consume.ts` sends all tools to the model when `skillScopeV2` is off, but
     `stream-callbacks.ts` still denies out-of-scope calls whenever `skillGate` exists.
   - Refs: `src/agent/loop/stream-consume.ts:117-124`, `src/agent/stream-callbacks.ts:275-277`
   - Fix: either disable dispatch scoping when `skillScopeV2` is off, or always filter the visible
     tool list whenever `skillGate` is active.

4. **Invalidate the token baseline on `/summarize-now`**
   - Evidence: `compactNowOnDemand` performs `wm.replace(...)` but never invalidates the
     `TokenBaselineBox`; the other replace paths do.
   - Refs: `src/agent/loop/compaction-wire.ts:129-152`, `src/agent/loop/compaction-wire.ts:202-203`,
     `src/agent/loop/recovery-executor.ts:148`
   - Fix: thread the baseline box into `compactNowOnDemand` and call the shrink/content invalidation
     owner method after replace.

5. **Emit non-fatal error signals when mention/context providers throw**
   - Evidence: `resolveContextEventsForTurn` and `resolveMentionInjectionMessages` both swallow throws
     and return `[]`, while the memory-recall sibling emits an error event.
   - Refs: `src/agent/loop/compaction-wire.ts:363-372`, `src/agent/loop/context-assembler.ts:27-52`,
     `src/agent/loop/context-assembler.ts:76-87`
   - Fix: emit a typed non-fatal `error` or `recovery` event in both catch blocks.

6. **Close the early-dispatch abort hole for `agent`**
   - Evidence: `agent` can early-start in `streaming-dispatch.ts`; on abort the loop returns
     `{kind:"aborted"}` before its `tool_result` is appended, even if the child already committed a
     side effect.
   - Refs: `src/agent/streaming-dispatch.ts:369-378`, `src/agent/streaming-dispatch.ts:575-600`
   - Fix: either await settlement for non-read-only early slots on abort and append their results, or
     restrict early dispatch to read-only tools until abort is transactional.

## Enablement blocker

- **Do not enable `QUANTA_BG_COMPACTION` until stale-suffix install is fixed**
  - Evidence: `speculativeSummarizeAdapter` snapshots `prefix/suffix`, awaits summarize, then returns
    `[synthetic, ...staleSuffix]`; `maybeCompact` can later install that payload into a mutated live
    `wm`, dropping or resurrecting messages.
  - Refs: `src/agent/compaction.ts:775-818`, `src/agent/loop/compaction-wire.ts:235-241`
  - Fix: reconcile against live working memory at install time using a boundary marker or prefix-only
    replacement; never install a stale slice payload.
