# ALBB-17 — Stop category and error taxonomy fixes

**Priority:** P2 (claim 1 = live label-fidelity defect) · claim 4 = P4 doc/removal · claim 3 = forward-fit · claim 2 = dropped
**Wave:** D
**Depends on:** none
**Owner:** `src/agent/stop-category.ts`, `src/agent/loop/turn-outcome.ts`, `src/agent/loop/stop-conditions.ts`, `src/agent/recovery.ts`, `src/agent/stop-reason/default-policy.ts`

## Goal

Make the structured `stopCategory` analytics label match the ACTUAL terminal
reason. Today a cost-cap / ledger-breach stop is emitted with the *max_turns*
category — analytically indistinguishable from an exhausted-turns stop and
carrying the wrong surface hint. Absorb Cursor's `stop_category` taxonomy
faithfully (the documented basis of `stop-category.ts`) by adding a typed
`budget` bucket, and close two smaller taxonomy gaps.

## Problem (ground-truthed 2026-07-09)

### Claim 1 — budget stop mislabelled `completed.max_turns` (REAL, always-on, P2)

Three live TS sites finish a budget/cost-cap run with the *max_turns* category:

- `src/agent/loop/turn-outcome.ts:123-128` (post-turn meter exhaustion on a
  continuing turn):
  ```ts
  return {
    kind: "finish",
    reason: "budget_exhausted",
    turns: args.turn,
    stopCategory: completedCategory("max_turns"),   // ← wrong category
  }
  ```
- `src/agent/loop/stop-conditions.ts:63` (`costPreflightCondition`, L2 pre-flight
  admission control):
  ```ts
  return { reason: "budget_exhausted", turns: turn - 1, stopCategory: completedCategory("max_turns") }
  ```
- `src/agent/loop/stop-conditions.ts:85` (`ledgerHardBreachCondition`, L4 cross-run
  ledger cap):
  ```ts
  return { reason: "budget_exhausted", turns: turn, stopCategory: completedCategory("max_turns") }
  ```

`completedCategory("max_turns")` (`src/agent/stop-category.ts:238-243`) resolves to
`{ kind:"max_turns", reasonCode: STOP_REASON_CODE.COMPLETED_MAX_TURNS /* "completed.max_turns" */,
hint:"Reached the configured maxTurns limit." }`. There is **no** budget/cost code
in the enum — verified across the full `STOP_REASON_CODE` table
(`src/agent/stop-category.ts:78-125`). So a budget-capped stop reports the wrong
`kind`, the wrong `reasonCode`, and a misleading hint ("maxTurns" when the run
was actually killed for cost). This is NOT dead config: the fail path fires
whenever `cfg.budgetMeter` / `cfg.budgetLedger` is configured — the L2/L4
cost-cap feature the jun-28 cost-cap work records as LIVE for
`apps/agent/{batch,daemon,ci-bot}` + ledger campaigns. The `reason:"budget_exhausted"`
top-level string is correct; only the structured `stopCategory` add-on is wrong,
which is exactly the field a surface switches on for actionable copy.

### Claim 4 — dual empty/malformed taxonomy, test-only arms (REAL, tiny, P4)

`completedCategory` (`src/agent/stop-category.ts:234-259`) still carries
`"empty_exhausted"` (→ `completed.empty_exhausted`, :244-249) and
`"malformed_exhausted"` (→ `completed.malformed_exhausted`, :250-255) arms. These
have **zero production callers** — the only references are the two assertions at
`tests/unit/agent/stop-category.test.ts:86` and `:93`. Production emits the
`model.*` codes instead: the recovery path (`src/agent/recovery.ts`) tags empty-
exhaustion `[empty-turn]` and malformed `[malformed-tool-use]`, which
`classifyErrorReason` maps to `MODEL_EMPTY_EXHAUSTED` / `MODEL_MALFORMED_TOOL_USE`
(`src/agent/stop-category.ts:159-177`). So there are two parallel code families
for the same event and only the `model.*` one is live. Collapse to the single
live taxonomy.

### Claim 3 — `[stop-abort]` / `[stop-hitl]` unmapped in `classifyErrorReason` (REAL but INERT, forward-fit)

When a `StopReasonPolicy` routes a provider `stop_reason`, `decideFromStopPolicy`
(`src/agent/recovery.ts:347-363`) emits terminal error reasons prefixed
`[stop-abort] …` (:359) and `[stop-hitl] …` (:361) — the two tags the default
policy can produce (`content_filtered → abort`, `guardrail_intervened → hitl`;
`src/agent/stop-reason/default-policy.ts:43-64`). `classifyErrorReason`
(`src/agent/stop-category.ts:144-228`) has arms for `[malformed-tool-use]` and
`[empty-turn]` but **none** for `[stop-abort]` / `[stop-hitl]`, so both fall
through to the terminal `runtime.unknown_error` bucket (:224-227) — mislabelled.
The matching codes already exist (`SYSTEM_ABORT: "system.abort"` :96,
`SHELL_NEEDS_APPROVAL: "shell.needs_approval"` :99). This is INERT today:
`config.stopReasonPolicy` is default-OFF (only read at
`src/agent/loop/same-turn-engine.ts:56`, `undefined` unless a caller passes it —
no production wiring). Land the mapping now WITH the policy so the classification
is correct the moment the policy is wired, rather than shipping a latent
mislabel.

### Claim 2 — timeout-shaped abort in `classifyStreamTurnError` (DROPPED, non-actionable)

`classifyStreamTurnError` (`src/agent/loop/stream-consume.ts:229-240`) treats
`config.signal.aborted`, `LLMError.kind === "aborted"`, and
`abortReasonOf(e) === "abort"` as soft aborts, but NOT
`abortReasonOf(e) === "timeout"` (`abortReasonOf` can return `"timeout"`,
`src/shared/abortable.ts:71-75`). However there is **no producer** feeding a raw
`AbortError{reason:"timeout"}` into this classifier: the LLM stream-timeout path
throws an `LLMError{kind:"network"}` (`src/llm/stream-timeout.ts:79-94`), which
is a retryable provider error, not a raw abort. So the missing `"timeout"` arm is
unreachable via the LLM path — dropped as non-actionable. (If a raw-timeout
producer is ever introduced into the stream path, re-open as a one-line arm.)

## Required changes (fail-closed, additive, byte-identical default)

1. **(P2 — claim 1) Add a typed `budget` bucket** to the Cursor taxonomy,
   additive so every existing consumer stays byte-identical (the jul-08
   debug-sink crown / red-on-injection byte-identity tests must stay green):
   - Extend `STOP_REASON_CODE` (`src/agent/stop-category.ts:78-125`) with
     `BUDGET_EXHAUSTED: "budget.exhausted"` (or split
     `COST_CAP: "budget.cost_cap"` for the L2 meter vs
     `LEDGER_BREACH: "budget.ledger_breach"` for the L4 ledger — prefer the
     split so `costPreflight` vs post-turn-meter vs ledger stay distinguishable
     in analytics).
   - Add a `"budget"` arm to `StopCategoryKind` (:41-50) — a typed enum change,
     which flushes every `switch (kind)` consumer (intended: fail-closed).
   - Add a `budgetCategory(source: "preflight" | "meter" | "ledger"): StopCategory`
     factory mirroring `completedCategory` / `interruptedCategory` (map each
     source to its code + a hint like "Stopped: run cost budget exhausted." —
     NOT the maxTurns hint).
   - Wire it at the three sites: `turn-outcome.ts:127` → `budgetCategory("meter")`,
     `stop-conditions.ts:63` → `budgetCategory("preflight")`,
     `stop-conditions.ts:85` → `budgetCategory("ledger")`. Leave the top-level
     `reason:"budget_exhausted"` string untouched (all downstream consumers,
     e.g. `src/runner/batch/eval/*`, key off it).
   - Regenerate the compiled `.js` mirrors (`turn-outcome.js`,
     `stop-conditions.js`) via the normal build — do NOT hand-edit; the stale
     `turn-loop.js:133,176` budget lines are a pre-existing build artifact whose
     `.ts` source no longer has those sites (`turn-loop.ts` only has the genuine
     max_turns finish at :188) and will drop on rebuild.

2. **(forward-fit — claim 3) Land the stop-policy tag mapping WITH a wiring/exhaustiveness
   test.** Add two arms to `classifyErrorReason`
   (`src/agent/stop-category.ts:144-228`), checked before the provider patterns
   (unambiguous prefixes, same as `[malformed-tool-use]` / `[empty-turn]`):
   - `^\[stop-abort\]` → `{ kind:"interrupted", reasonCode: SYSTEM_ABORT, hint:… }`
   - `^\[stop-hitl\]`  → `{ kind:"needs_user_approval", reasonCode: SHELL_NEEDS_APPROVAL, hint:… }`
   Codes already exist; no new enum entries. Because `classifyErrorReason` is
   fail-open by contract (unmatched → `runtime.unknown_error`), pair this with an
   EXHAUSTIVE cross-check test (see Proof rails) so a newly-added `StopAction`
   arm that lacks a `classifyErrorReason` mapping goes RED — fail-closed on the
   taxonomy, not silent.

3. **(P4 — claim 4) Collapse the dual empty/malformed taxonomy.** Delete the
   never-called `"empty_exhausted"` / `"malformed_exhausted"` arms from
   `completedCategory` (`src/agent/stop-category.ts:244-255`) and their two enum
   members `COMPLETED_EMPTY_EXHAUSTED` / `COMPLETED_MALFORMED_EXHAUSTED` (:107-110),
   OR convert both to the live `model.*` codes. Drop the two now-orphaned test
   assertions (`tests/unit/agent/stop-category.test.ts:86,93`). Live production
   already routes through `model.empty_exhausted` / `model.malformed_tool_use`.

4. **(claim 2) No change.** Leave `classifyStreamTurnError` as-is; note the
   missing `"timeout"` arm as a defensive-completeness item only, re-openable if a
   raw-timeout producer is introduced into the stream path.

No arbitrary thresholds are introduced — every string prefix matched is a
contract-fixed tag produced by our own code.

## Acceptance

- A run stopped by `budgetMeter`/`budgetLedger`/`costPreflight` reports
  `stopCategory.kind === "budget"` and `reasonCode` starting `budget.` — NOT
  `kind:"max_turns"` / `"completed.max_turns"` — and a cost-cap hint (not the
  maxTurns hint).
- The top-level `reason:"budget_exhausted"` string is unchanged (downstream
  `src/runner/batch/eval/*` classifiers still see it).
- A `[stop-abort]` reason classifies to `interrupted`/`system.abort` and
  `[stop-hitl]` to `needs_user_approval`/`shell.needs_approval` (not
  `runtime.unknown_error`).
- No `completedCategory("empty_exhausted"|"malformed_exhausted")` arm remains
  (or it maps to `model.*`); the two test-only assertions are gone.
- Byte-identical default-OFF: no consumer that doesn't read `stopCategory`
  changes; debug-sink byte-identity tests stay green.

## Proof rails (red-on-injection, not vacuous)

Behavioral tests that FAIL if the defect is reintroduced:

1. **Budget label fidelity — table-driven over all three sites.** In
   `src/agent/loop/stop-conditions.test.ts` (existing: asserts
   `reason:"budget_exhausted"` at :74 but NOT the category — that gap is the
   bug), add assertions that a configured meter/ledger/preflight terminal yields
   `stopCategory.reasonCode.startsWith("budget.")` and
   `stopCategory.kind === "budget"`. Mirror in
   `tests/unit/agent/loop/turn-outcome.test.ts` (the budget-exhausted case at
   :151-166 currently checks `reason` but not `stopCategory`). Reverting the fix
   to `completedCategory("max_turns")` must turn these RED.

   ```sh
   bun test src/agent/loop/stop-conditions.test.ts
   bun test tests/unit/agent/loop/turn-outcome.test.ts
   ```

2. **Exhaustive StopAction ↔ classifyErrorReason cross-check (fail-closed).** In
   `tests/unit/agent/stop-category.test.ts`, drive every tag `decideFromStopPolicy`
   can emit (derive from `DEFAULT_STOP_REASON_ROUTING` in
   `src/agent/stop-reason/default-policy.ts:54-64` — the `abort` and `hitl`
   arms) and assert `classifyErrorReason("[stop-abort] …")` /
   `("[stop-hitl] …")` return a NON-`runtime.unknown_error` code. A new
   `StopAction` prefix without a mapping ⇒ RED.

   ```sh
   bun test tests/unit/agent/stop-category.test.ts
   ```

3. **Taxonomy-collapse guard.** After removing the test-only arms, a grep-guard
   (or a `stop-category.test.ts` assertion) that `completedCategory` accepts only
   `"normal" | "max_turns"` — reintroducing an `empty_exhausted`/`malformed_exhausted`
   arm without a production caller fails typecheck / the test.
