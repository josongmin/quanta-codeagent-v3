# ALBB-07 — Reactive PTL: observable post-compact hook, salvage `activeModel` SSOT, advisory-budget hardening

**Priority:** P1
**Wave:** B
**Depends on:** none
**Owner:** `src/agent/loop/recovery-executor.ts`, `src/agent/loop/emit-helpers.ts`, `src/agent/loop/same-turn-engine.ts`

## Goal

Close two genuine reactive-recovery defects on the `recovery-executor.ts` surface —
a **silent post-compact hook** and a **salvage window mis-target under a sticky
model swap** — plus one directional **advisory-guard hardening**. All three share
`applyNonSuccessRecoveryAction`'s `do === "compact"` branch and are fixed together.

Ground-truth: all three cited patterns exist in current code (verified by direct
read, line numbers re-anchored below — the ticket's original `:169-171` / `:162-164`
/ `:120-122` had drifted only slightly).

## Problem

### 1. Reactive post-compact hook is silently swallowed (real, actionable)

`applyNonSuccessRecoveryAction` fires the `post_compact` hook and the objective
`setNextActions` INLINE inside a bare `try { … } catch {}` — `recovery-executor.ts:149-171`:

```ts
try {
  const provenance: import("../recovery-reason").RecoveryProvenance = { … }
  const threadId = config.sessionId ?? ""
  await config.hooks?.emit({ type: "post_compact", threadId, provenance })   // :159 inline emit
  if (config.objective !== undefined && threadId.length > 0 &&
      !objectiveBudgetExhausted(config, threadId)) {
    config.objective.setNextActions(threadId, [                              // :165
      "Resuming after mid-turn compaction (PTL recovery)",
    ])
  }
} catch {
  // No-throw.                                                               // :169-171 SILENT
}
```

Two defects here:

- **Silent failure.** A throwing `post_compact` subscriber (or a throwing
  `setNextActions`) is swallowed with **no `logger.warn` and no stream event** —
  the failed hook is invisible to the agent-state stream (north-star: "what is
  the agent doing / why did it stall" is unanswerable). The existing hellgate
  `tests/unit/loop-reactive-compaction-emit-hellgate.test.ts:192` ("throwing
  emitter is swallowed ⇒ loop still completes") PINS today's swallow behavior —
  that is the mutation target to invert to "observable".
- **Duplicated hook plumbing.** The inline `config.hooks?.emit({ type:
  "post_compact", … })` re-implements `buildPostCompactEmit`
  (`src/agent/loop-helpers.ts:175-185`), which the PROACTIVE path already uses as
  its SSOT (`compaction-wire.ts:301`). Two copies of the same emit shape drift.

### 2. Reactive `dropOldestSalvage` mis-targets the window under a sticky swap (real, actionable — highest value)

`recovery-executor.ts:120-123` computes the salvage `targetTokens` with a **bare**
window resolve:

```ts
targetTokens: resolveCompactionLimitTokens(
  config.compaction?.thresholdTokens,
  resolveWindowModel(config.llm),          // :122 — activeModel param OMITTED
),
```

`resolveWindowModel` (`emit-helpers.ts:149-155`) defaults its second arg to
`configuredModel(llm)` — i.e. the **base** model. So when a skill/sticky swap has
moved the turn onto a **smaller-window** model, the reactive salvage sheds against
the BASE window and **under-sheds** (leaves the transcript above the active
model's real limit → the very context error that triggered salvage can recur).

The PROACTIVE path does NOT have this bug — it threads the resolved active model
end-to-end: `compaction-wire.ts:315` and `:511` both call
`resolveWindowModel(config.llm, activeModel)`. And `same-turn-engine.ts:34`
ALREADY resolves the correct `activeModel`
(`resolveActiveModelId(turnConfig, session.skillGate?.activeOverride())`) and
threads it into `prepareTurnContext` (`:49`) — but **drops it** when calling
`applyAction` (`same-turn-engine.ts:57-64`), so the reactive branch never sees it.
This is a pure wiring gap, not a heuristic.

### 3. `objectiveBudgetExhausted` fails OPEN on a throwing store (real, but ADVISORY only — do NOT market as an enforcement bypass)

`emit-helpers.ts:157-166`:

```ts
export const objectiveBudgetExhausted = (config, threadId): boolean => {
  if (!runtimeConfig().objectiveBudgetEnforce) return false
  if (config.objective === undefined || threadId.length === 0) return false
  try {
    return config.objective.get(threadId)?.status === "budget_limited"
  } catch (e) {
    logger.warn(`loop.objectiveBudgetExhausted: ${errMessage(e)}`)
    return false                            // :164 — fail-OPEN even with enforce ON
  }
}
```

With enforce ON, a throwing objective store returns `false` ("not exhausted"), so
the reactive branch proceeds to `setNextActions`. This is a real fail-open, BUT
its blast radius is only the **advisory** "Resuming after mid-turn compaction"
next-actions nudge in the compact branch — it is NOT the loop-continuation
enforcement gate.

The ACTUAL idle goal-continuation enforcement lives in
`src/agent/objective/continuation.ts` and is **independently fail-closed** against
a throwing store: `readStatus` (`:279-285`) returns `null` on throw →
`evaluateContinuation` (`:117`) hits `goalStatusAtScan === null` → `skip("no-goal")`
(no launch); `runIdleContinuation`'s outer `try/catch` (`:274-276`) also degrades
to `{ launched: false }`. So a throwing store CANNOT bypass real budget enforcement
— it only fails to launch. Frame change #3 as **directional advisory-guard
hardening**, not "closing an enforcement bypass."

## Required changes

1. **Post-compact observability + SSOT (claim 1).**
   Replace the inline `config.hooks?.emit(...)` with the shared
   `buildPostCompactEmit(config.hooks, threadId)` (single SSOT with the proactive
   path). On a throw from EITHER the hook OR `setNextActions`, do NOT swallow
   silently — `logger.warn(...)` AND emit a stream event so the failed post-compact
   is observable (`config.stream.emit({ type: "recovery", reason: … })`, reusing
   the existing `emitRecovery` seam; a `"recovery"` event is already in the surface
   vocabulary — no new event type, mirrors Codex/Claude-Code surfacing recovery
   steps on the event stream). Loop MUST still complete (no-throw contract
   preserved). Byte-identical on the happy path (no throw).

2. **Thread `activeModel` into reactive salvage (claim 2 — SOTA++ wiring, no heuristic).**
   Add an `activeModel: string` parameter to `applyAction` /
   `applyNonSuccessRecoveryAction`. Pass `same-turn-engine.ts:34`'s
   already-resolved `activeModel` into the `applyAction` call at
   `same-turn-engine.ts:57-64`. Use it at `recovery-executor.ts:122` as
   `resolveWindowModel(config.llm, activeModel)` — mirroring the proactive SSOT
   (`compaction-wire.ts:315`). No default fallback that re-collapses to base:
   thread the real value end-to-end.

3. **Advisory-guard hardening (claim 3 — directional only).**
   With enforce ON and a throwing store, `objectiveBudgetExhausted` should
   fail-CLOSED (`return true` — treat as exhausted → skip the advisory nudge) and
   keep the `logger.warn`. Document IN THIS TICKET that this is advisory hardening
   ONLY: `continuation.ts` already fail-closes the real enforcement, so this is not
   an enforcement-bypass fix and needs no efficacy A/B.

## Acceptance

- A throwing `post_compact` hook (or throwing `setNextActions`) surfaces on the
  event stream (a `recovery` event) AND logs a warn; the loop still completes.
- Reactive `dropOldestSalvage` under a sticky swap to a smaller-window model
  targets the ACTIVE model window (verified with a mocked window resolver), not
  the base window.
- With `objectiveBudgetEnforce` ON, a throwing objective store makes
  `objectiveBudgetExhausted` return `true` (fail-closed advisory), not `false`.
- Default happy path is byte-identical (no throw / no sticky swap).

## Proof rails (red-on-injection, not vacuous)

- **Claim 1 — post-compact observability.** Extend
  `tests/unit/loop-reactive-compaction-emit-hellgate.test.ts` (which already drives
  a real reactive-compaction loop with a spy emitter, e.g. test `(3)` at `:192`):
  inject a `hooks.emit` that THROWS on `post_compact`, assert the run still
  completes AND the surface stream received a `recovery` event referencing the
  failed post-compact. Mutation guard: reverting to the empty `catch {}` must turn
  this test RED (no stream event observed).

- **Claim 2 — salvage `activeModel`.** New hellgate
  `tests/unit/agent/albb-07-ptl-salvage-activemodel.test.ts`: mock the window
  resolver (or inject a `config.llm` base with a large window + a sticky
  `activeModel` with a SMALL window), enable `dropOldestSalvage`, force a reactive
  compact, and assert the salvage `targetTokens` equals the SMALL (active) window's
  derived limit — NOT the base. Mutation guard: dropping `activeModel` from the
  `applyAction` call (or reverting `:122` to the bare `resolveWindowModel(config.llm)`)
  must turn it RED. Pair with a control assertion (no sticky swap ⇒ target ==
  base window) so the test proves the wire, not a constant.

- **Claim 3 — advisory fail-closed.** Unit test on `objectiveBudgetExhausted`
  (co-locate near existing objective-budget coverage under `tests/unit/`): with
  `objectiveBudgetEnforce` ON and an objective store whose `get` throws, assert
  the function returns `true`. Mutation guard: reverting to `return false` in the
  catch must turn it RED.

```sh
bun test tests/unit/loop-reactive-compaction-emit-hellgate.test.ts
bun test tests/unit/recovery-hellgate.test.ts
bun test tests/unit/agent/albb-07-ptl-salvage-activemodel.test.ts   # new
```

## Notes

- Measure-first: none of the three changes alter default happy-path behavior
  (byte-identical when no throw / no sticky swap), so no efficacy A/B is required
  beyond the hellgates. The claim-2 under-shedding fix is a correctness fix, not a
  tunable — no arbitrary threshold introduced.
- No overlap sufficient to merge with another ticket; the three defects co-locate
  on the `recovery-executor.ts` compact branch and are fixed in one change.
