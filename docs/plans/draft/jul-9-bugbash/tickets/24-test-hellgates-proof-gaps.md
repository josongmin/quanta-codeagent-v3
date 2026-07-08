# ALBB-24 — Test hellgates and proof-gap closure

**Priority:** P3 (META / tracking — enables regression-proofing for all waves)
**Wave:** F — run in parallel with Wave A
**Depends on:** the sibling implementation tickets whose behaviors these tests pin
**Owner:** `tests/unit/agent/`, `tests/integration/`

## Goal

Give each landed Wave A/B fix a **named behavioral hellgate** (red-on-injection
proof rail) so a re-inline OR a silent behavior regression both fail loudly.
This is a tracking ticket: close only after the referenced fixes ship and each
has a matching executable proof.

## Status (ground-truth, jul-9)

Every falsifiable claim below was verified against current source. Two facts
frame the whole ticket:

- The paths named here **do run today** under existing integration tests
  (`runAgent → runTurn → streamConsume → createStreamDispatcher`, and
  `maybeCompact → applyProactiveResult`). The gap is **missing DIRECT / NAMED
  coverage**, not untested reachability. That is exactly why the remedy is
  proof-pinning named hellgates, not "these paths might be broken".
- The structural facade guard must stay structural. Do **not** bloat it with
  behavior.

## Structural vs behavioral (verified)

`tests/unit/agent/loop-decomposition-hellgate.test.ts` is **purely structural**
— header literally reads *"Structural hellgate — `loop.ts` must remain a thin
facade"*. It does `readFileSync` + `toContain` / `not.toMatch` over src strings
(e.g. `loop-decomposition-hellgate.test.ts:12,20-21`: asserts `loop.ts` ≤ 20
lines and has no `const runAgent =`). It never invokes `runAgent` or exercises
any runtime effect. Keep it as-is; add a **new behavioral namespace**
`tests/integration/agent-loop-bugbash/` (does not exist today —
`ls tests/integration/agent-loop-bugbash/` ⇒ "No such file or directory";
`tests/unit/agent/albb-*` ⇒ no matches).

## Proof gaps to close

| Gap | Verified current location | Test to add / extend |
|-----|---------------------------|----------------------|
| `createStreamDispatcher` — deny + history-patch seams have **zero named test** | `src/agent/stream-callbacks.ts:252` (factory); deny via `handleSkillScope`→`skillScopeDeny` (`:173`, short-circuits dispatch); history-patch via `patchHistoryOutcome` (`:141`, called `:390`) | Behavioral hellgate driving `streamConsume` with a fake session/state; assert observable EFFECTS on both seams (below) |
| `applyProactiveResult` — `no_boundary` strikes but **`empty_summary` records no strike** | `src/agent/loop/compaction-wire.ts:437-438` (`else if (result.reason === "no_boundary") breaker?.recordProactive(before, before)`); `empty_summary` is a real `compactIfNeeded` reason (`src/agent/compaction.ts:658`) that falls through both branches | Unit + paired-control on the strike seam (below); decide first whether `empty_summary` SHOULD strike (see "Open question") |
| `allowlistEscalated` unwired | pairs with ALBB-11 — **not adjudicated here** | Bootstrap wiring test in ALBB-11 |
| `content_filtered` default proceed | pairs with ALBB-03 — **not adjudicated here** | E2E `runAgent` without policy in ALBB-03 |
| Interrupted-turn signal abort | pairs with ALBB-06 | Capture-buffer test in ALBB-06 |
| SDK optional ports parity | pairs with ALBB-12 | embed + env knobs in ALBB-12 |
| Scheduler abort event shape (`turn.completed.outcomeReason`) | pairs with ALBB-04 | assertion in ALBB-04 |
| Stream fan-out throw | pairs with ALBB-05 | host unit in ALBB-05 |

> Removed: the "verify-guard tombstone" (ALBB-02) and "ownership post-rewrite"
> (ALBB-01) rows — both tickets were deleted as not-real (defect unreachable), so
> there is no shipping fix to pin. Per measure-first, no speculative test here.

The deferred rows point to sibling tickets and are gated on those landing — do
not write speculative tests here for behavior that hasn't shipped (measure-first:
only assert what the fix actually ships).

## Required changes

Behavior-over-structure hellgates (the Claude Code / Codex convention: a
structural facade guard is necessary but not sufficient; each behavioral contract
gets its own executable proof). All new tests are **fail-closed**: they must go
RED if the wiring is reverted.

1. Create `tests/integration/agent-loop-bugbash/` with a `README.md` indexing
   ALBB ids → named test files, and note placement in `tests/README.md`.

2. **`createStreamDispatcher` behavioral hellgate** (ALBB-24 embedded in
   `describe`). Drive `streamConsume` (or the dispatcher directly) with a fake
   `TurnSession`/`TurnState` and assert observable EFFECTS, not just "it runs":
   - **Deny path** — with a `skillGate` that denies the called tool
     (`skillScopeV2` OFF), assert the injected dispatch port was **never
     invoked** (fresh-readback: a spy dispatch counter stays 0) and the returned
     block is the `skillScopeDeny` shape (`ok:false`, `is_error:true`, preview
     `"skill-scoped"`, `stream-callbacks.ts:173`).
   - **History-patch path** — supply a non-empty `toolHistory` slot with the
     call id, let a dispatch resolve `{ok, preview}`, then **fresh-readback** the
     slot and assert `slot.ok` / `slot.output` were back-patched
     (`patchHistoryOutcome`, `stream-callbacks.ts:141-155`). Paired control:
     `toolHistory === undefined` ⇒ no throw, no mutation.
   - **Mutation pin (red-on-injection):** flip the dispatch decision — remove the
     `scoped ??` short-circuit (`stream-callbacks.ts:355-356`) so a denied tool
     dispatches anyway; the deny-path assertion (dispatch counter stays 0) must
     go RED.

3. **`applyProactiveResult` strike hellgate** (ALBB-24 / ALBB-08 in `describe`).
   Wire against the real `CompactionBreaker` seam
   (`src/agent/compaction-breaker.ts`, `recordProactive` `:96`, cap
   `maxNoProgressProactive:3` `:50`):
   - **Strike case** — a proactive result with `reason:"no_boundary"` asserts
     `breaker.recordProactive` was called `(before, before)` i.e. a real
     no-progress strike (`breaker.strikes.proactive === 1`).
   - **Paired control** — a `compacted:true` result records `(before, after)` and
     resets the classifier; `strikes.proactive` still increments but with a real
     `after`. Assert the compaction event / archive append fire.
   - **Mutation pin:** revert the strike (`compaction-wire.ts:438`) ⇒
     `strikes.proactive` reads 0 ⇒ RED. Note the existing
     `src/agent/loop/__tests__/proactive-compact-failure-breaker.test.ts` already
     pins the **throw** branch (`:386`) — this hellgate closes the distinct
     **result-branch** seam (`:437-438`), which has **no** direct test today
     (`grep applyProactiveResult tests/` ⇒ 0 hits).

## Open question (decide before writing test 3)

`applyProactiveResult` records a strike on `no_boundary` but **silently ignores
`empty_summary`** (`compaction.ts:658` — summarizer returned empty text). An
`empty_summary` proactive result frees nothing yet accrues **no** strike, so a
summarizer that keeps returning empty over threshold never trips the futility
breaker — the same fail-open the M9 throw-fix closed for the catch branch. If
this is confirmed a bug, widen the strike guard to
`result.reason === "no_boundary" || result.reason === "empty_summary"` and add
that case to the hellgate. If intended (empty summary is recoverable / transient
and handled elsewhere), document why and pin the no-op with a test. **Do not
change behavior blind — confirm intent first (measure-first).**

## Acceptance

- `tests/integration/agent-loop-bugbash/README.md` exists and indexes shipped
  ALBB ids.
- Each landed Wave A/B fix has ≥1 named test whose `describe` references its ALBB
  id.
- `bun test tests/integration/agent-loop-bugbash/` green after Wave A+B.
- CI bugbash slice runs:
  `bun test tests/integration/agent-loop-bugbash tests/unit/agent/albb-*`

## Proof rails

```sh
# Structural facade guard stays structural (unchanged):
bun test tests/unit/agent/loop-decomposition-hellgate.test.ts
# New behavioral namespace + per-ticket named units:
bun test tests/integration/agent-loop-bugbash/
bun test tests/unit/agent/albb-*
# Existing sibling that already pins the proactive THROW branch:
bun test src/agent/loop/__tests__/proactive-compact-failure-breaker.test.ts
```

Each behavioral test is validated by its own red-on-injection mutation (above):
reverting the wiring must fail the assertion — no vacuous compile/`toContain`
asserts.

## Note

This ticket is **ongoing** — check off sub-rows as sibling implementation tickets
merge. Do **not** close ALBB-24 until Wave A+B items each have a matching named,
red-on-injection test.
