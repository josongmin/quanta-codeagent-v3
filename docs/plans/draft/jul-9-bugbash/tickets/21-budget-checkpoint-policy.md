# ALBB-21 — Budget ledger soft breach + per-turn checkpoint + converge reason

**Priority:** P3
**Wave:** E
**Depends on:** ALBB-07
**Owner:** `src/agent/loop/emit-helpers.ts`, `src/agent/verify-checkpoint-bridge.ts`, `src/agent/converge/protocol.ts`

> Verified 2026-07-09 by fresh reads (not line-trust). 4 of 5 original
> sub-claims are real code TODAY; sub-claim #3 (dedup-before-I/O) is
> **intended-design** and its proposed "retry" fix would REGRESS into per-call
> anchor I/O thrash — it is DROPPED. Priority lowered P2→P3: every real
> residual is operator observability (soft-breach surfacing, verify-bridge
> failure logging) and the converge `reason` mismatch has **zero production
> consumer** today (`src/apps/terminal/brain-mode.ts:583,633` read only
> `converged`/`rounds`, never `reason`).

## Goal

Surface soft budget signals (advisory, non-fatal); make verify-bridge
anchor-advance failures observable; fix the converge `reason` vs `converged`
disagreement at `maxRounds=1`; DECIDE (wire-or-delete) the dead `per-turn`
checkpoint mode by measurement, not by shipping a live path blind.

## Problem

1. **Soft budget breaches are computed then DISCARDED.** The L4 ledger sink in
   `src/agent/loop/emit-helpers.ts:68-77` calls `config.budgetLedger?.record({…})`
   and throws away the returned `RecordResult`:

   ```ts
   ({ config, ev }) =>
     config.budgetLedger?.record({ model: ev.model, … })  // ← return dropped
   ```

   `RecordResult.breaches` (`src/agent/budget-ledger.ts:168-171`) carries the
   typed, deterministic-order breach list (0..4 entries, one per configured
   `BudgetPolicy` limit — `sessionSoftLimit`/`dailySoftLimit`/`sessionHardLimit`/
   `dailyHardLimit`, `src/agent/budget-ledger.ts:152-161`). The ONLY breach the
   run reacts to is HARD: `ledgerHardBreachCondition`
   (`src/agent/loop/stop-conditions.ts:72-86`) reads `budgetLedger?.hardBreach()`,
   whose contract EXPLICITLY excludes soft breaches — *"SOFT breaches are
   advisory and never returned here"* (`src/agent/budget-ledger.ts:195`). So a
   crossed **soft** cap fires no `StreamEvent`, no decision, no log: the operator
   never learns they crossed the advisory ceiling. There is no `budget_breach`
   arm in the `StreamEvent` union yet (`src/llm/types.ts:194-210` has `usage`
   only) — the surface simply doesn't exist.

2. **`per-turn` checkpoint mode is wired-but-DEAD.** `shouldAnchorAfterTurn`
   exists and is internally consistent (`src/agent/checkpoint-policy.ts:197-201`
   returns `!anchored.has(keyOf(...))` when `cfg.mode === "per-turn"`; the
   granular wrapper delegates at `src/agent/per-tool-checkpoint/granular-policy.ts:203-206`)
   and is covered by unit tests
   (`tests/unit/checkpoint-policy-hellgate.test.ts:299-317`,
   `tests/unit/per-tool-checkpoint-hellgate.test.ts:123,151`). But it has **zero
   production callers** — grep for `shouldAnchorAfterTurn` outside `.test.ts`
   yields only the definition, the internal delegation, and doc comments. No
   turn-epilogue site ever calls it, so selecting `mode: "per-turn"` silently
   produces NO anchors.

3. ~~**Checkpoint dedup before I/O.**~~ **DROPPED — intended-design.**
   `takeAnchor` records the dedup key BEFORE `registerHead`
   (`src/agent/checkpoint-policy.ts:294-301`) with an explicit contract comment:
   *"Record FIRST so a concurrent wrap sees the dedup; even if the anchor I/O
   rejects, we don't want to re-attempt the I/O on every dispatched call within
   the same turn."* The original "allow retry on failure" fix would turn one
   anchor-per-turn into anchor-I/O per dispatched tool call — a self-inflicted
   O(calls) thrash. Not a defect.

4. **Verify-checkpoint bridge failure is SILENTLY swallowed.** On a verify PASS
   the guard fires the anchor-advance fire-and-forget at
   `src/agent/guards/verify-guard.ts:58-59`:

   ```ts
   if (verifyCheckpoint !== undefined) {
     void verifyCheckpoint.bridge.onVerifySuccess(verifyCheckpoint.cwd)
   }
   ```

   The bridge's catch is EMPTY — no log, no counter
   (`src/agent/verify-checkpoint-bridge.ts:38-47`):

   ```ts
   try {
     await odb.markVerified(workspace)
   } catch {
     // NO-THROW: … (comment only — no log)
   }
   ```

   No-throw is the correct contract, but a `markVerified` failure (uninitialized
   ODB, spawn-fail on a missing `git`, a failed `git update-ref`) is invisible:
   the verified anchor silently never advances, and a later
   `rewindToVerified` finds nothing, with no breadcrumb of WHY.

5. **Converge `reason` disagrees with `converged` at `maxRounds=1`.** In
   `runConvergeProtocol` (`src/agent/converge/protocol.ts:130`) the outcome
   re-derives `converged` from a fresh final judge but leaves `reason` at
   whatever the loop body last set:

   ```ts
   let reason: ConvergeReason = "rounds-exhausted"   // line 102, default
   while (rounds < bounds.maxRounds) { … if (verdict.green) { reason = "green"; break } … }
   return { converged: proto.judge().green, rounds, turnsConsumed, carry, reason }  // line 130
   ```

   With `maxRounds=1` and a RED→green repair on the single round: round 0 judges
   RED (actionable) → feedback → `generate` (the repair turns it green) →
   `rounds=1`; the `while` guard `1 < 1` is now false, so the loop EXITS via the
   bound — the `verdict.green` break at line 110-113 never runs. Final
   `proto.judge().green` is `true` ⇒ `converged: true`, but `reason` was never
   overwritten ⇒ `"rounds-exhausted"`. A converged run is telemetried as "out of
   budget." (No production consumer reads `reason` today, so impact is telemetry
   integrity only — but the invariant is still violated.)

## Required changes

1. **Soft breach → advisory `budget_breach` StreamEvent (fail-safe surfacing,
   evidence-driven, no invented threshold).** Do NOT add a heuristic threshold —
   the breach set is already typed and computed from the configured
   `BudgetPolicy` limits. Add a NEW `UsageSink` at the END of `USAGE_SINKS`
   (`src/agent/loop/emit-helpers.ts:35-104` — this is the file's own documented
   OCP extension contract: *"Adding a downstream … is appending a sink HERE —
   never surgery on the `emitUsage` hot body"*, lines 28-32). The sink consumes
   the `RecordResult` (which requires threading `record`'s return through the
   sink — capture it into `UsageSinkCtx`) and, on non-empty `breaches`, calls
   `config.stream.emit` with a NEW `budget_breach` arm on the `StreamEvent`
   union (`src/llm/types.ts` near the `usage` arm, line 194) carrying
   `{severity, scope, observed, limit}` derived verbatim from each `BudgetBreach`
   (`src/agent/budget-ledger.ts:142-150`). Mirror Claude Code / Codex cost-
   warning UX: an **advisory, non-fatal banner** — SOFT never stops the run
   (HARD already does, via `ledgerHardBreachCondition`). Default-OFF preserved:
   no `budgetLedger` ⇒ no `record` ⇒ no breaches ⇒ no emit, byte-identical.

2. **Converge `reason`/`converged` from ONE final judge (narrowest fix).**
   Derive both from the same terminal verdict at
   `src/agent/converge/protocol.ts:130`:

   ```ts
   const finalGreen = proto.judge().green
   return { converged: finalGreen, rounds, turnsConsumed, carry,
            reason: finalGreen ? "green" : reason }
   ```

   This cannot produce `converged: true` with a non-`green` reason again. Keep
   the in-loop `reason` assignments (they still carry `watchdog`/`no-signal`/
   `rounds-exhausted` for the not-green paths).

3. **Verify-bridge: keep no-throw, add ONE observable breadcrumb.** Insert a
   single `logger.debug(...)` inside the empty catch at
   `src/agent/verify-checkpoint-bridge.ts:40-47` (add the `logger` import from
   `@/shared` — currently the file imports only the `ShadowOdb` type). Do NOT
   change the gate shape, the no-throw contract, or the fire-and-forget call
   site. The log makes anchor-advance failures greppable without altering
   control flow.

4. **`per-turn` checkpoint: DECIDE by measurement (wire-or-delete), do not ship
   a live path blind.** Two mutually-exclusive resolutions, pick via the
   integration proof rail the Acceptance already specifies — do not merge one
   without that rail green:
   - **WIRE:** call `shouldAnchorAfterTurn(turnId, cwd)` at the turn epilogue,
     gated behind the existing `mode === "per-turn"` branch, taking an anchor
     (`registerHead` + `recordAnchored`) when it returns `true`; land ONLY with
     an integration test asserting an anchor is actually created for a
     `per-turn` policy.
   - **DELETE:** remove the `per-turn` mode arm from `CheckpointPolicyConfig`
     and `shouldAnchorAfterTurn`'s live branch if no surface selects it — but
     keep the tests that pin the delegation contract for the remaining grains.

## Acceptance

- A configured **soft** limit crossing emits exactly one `budget_breach`
  `StreamEvent` (severity+scope+observed+limit); HARD path unchanged (still
  stops via `ledgerHardBreachCondition`).
- `runConvergeProtocol` with `maxRounds=1`, RED→green repair ⇒
  `{ converged: true, reason: "green" }` (never `"rounds-exhausted"`).
- Verify-bridge `markVerified` throw ⇒ still no throw escapes `decide`, AND a
  `logger.debug` line is emitted (observable).
- `per-turn` mode either creates anchors in an integration test (WIRE) or the
  mode is removed (DELETE) — no dead live path shipped.

## Proof rails

Red-on-injection / behavioral (each fails if the defect is reintroduced), NOT a
vacuous compile assert:

1. **Soft-breach sink** — new test in `tests/unit/` (co-locate with
   `tests/unit/budget-ledger-hellgate.test.ts`). Stub a `BudgetLedger` whose
   `record()` returns `{ cost, breaches: [<session-soft>] }`; drive `emitUsage`
   with a capturing `config.stream`; assert **exactly one** `budget_breach`
   event with the breach's `{scope, observed, limit}`. Without the sink the
   assertion is RED (zero events). Also assert `breaches: []` ⇒ zero
   `budget_breach` events (no false-positive banner).

2. **Converge reason** — add the MISSING case to
   `src/agent/converge/protocol.test.ts` (the RED→green test at line 40-49 uses
   `maxRounds: 4`, whose slack MASKS this bug — the green break fires on the
   re-entered round). New case: `fake([RED, GREEN])` with `maxRounds: 1` ⇒
   `expect(o.converged).toBe(true)` AND `expect(o.reason).toBe("green")`.
   Pre-fix this is RED (`reason === "rounds-exhausted"`).

3. **Verify-bridge log** — extend
   `tests/unit/verify-checkpoint-bridge-wire-hellgate.test.ts` test (3)
   (`markVerified throws ⇒ no throw escapes`, lines 136-165): spy `logger.debug`
   and assert it is called once on the swallowed failure, in ADDITION to the
   existing no-throw assertion. Pre-fix RED (empty catch logs nothing).

4. **`per-turn` wiring (WIRE branch only)** — integration test that constructs a
   `per-turn` checkpoint policy, runs a turn through the epilogue, and asserts an
   anchor SHA was registered. This test is the gate: do not land the WIRE path
   without it going green (and RED before the wiring).

```sh
bun test tests/unit/budget-ledger-hellgate.test.ts
bun test tests/unit/verify-checkpoint-bridge-wire-hellgate.test.ts
bun test src/agent/converge/protocol.test.ts
bun test tests/unit/checkpoint-policy-hellgate.test.ts tests/unit/per-tool-checkpoint-hellgate.test.ts
```
