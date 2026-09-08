# R09 receipt — P1-A-02 / G-F15

Status: **implemented** (not verified).

Worker: W1-C R09  
Worktree: `/Users/songmin/quanta-codeagent-v3-w1-r09`  
Branch: `sep8-w1-r09`  
HEAD: `f5f4875799141068af73e604129c8b9a09f76007`

## Snapshot

| Field | Value |
|---|---|
| source HEAD | `f5f4875799141068af73e604129c8b9a09f76007` |
| Bun | 1.3.14 |
| OS | Darwin / macOS |
| policy | W0.6 frozen known / unknown / estimated |
| god-code | `budget-ledger.ts` 828 (unchanged band), `emit-helpers.ts` 522; codec split into `src/agent/budget-ledger/` |

## Findings closed (owner-local)

### P1-A-02 — meter/ledger policy divergence

- `emitUsage` passes canonical `eventCost` into `budgetLedger.record`. Ledger does not re-price that event with sonnet `safeFallback`.
- `unknown` (`pricingKnown:false`, `totalUsd:0`): excluded from USD hard stop. Token ticks unchanged.
- `known` over budget: `hardBreach()` + `ledgerHardBreachCondition` still stop.
- `estimated` (live record without canonical cost): display fallback remains (HELL-3/30); **not** USD-enforced this wave.
- serialize stamps `pricingProvenance` (+ canonical `cost` when supplied). Hydrate missing provenance is **not** `known`.

### G-F15 — unpriced eval as zero

- `costPricing` sibling on `CoverageMatrix`: completeness, known subtotal, priced/unpriced counts.
- `projectEvalCost` is the single headline/detail projection.
- all-unknown → `unavailable` (not `$0`); mixed → partial + known subtotal; known-zero → `$0` allowed; no-usage unchanged.

## RED

Command (pre-implementation; unknown still fallback-enforced):

```
bun test tests/unit/sep8-remediation/r09/ tests/integration/sep8-remediation/r09/ tests/integration/budget-ledger-real-loop-e2e.test.ts
```

Load-bearing failures (not import/syntax of the product):

- e2e unknown + $1 cap: `reason === "budget_exhausted"` (wanted not).
- audit probe emitUsage 1M unknown: `snapshot.totalCost === 3` (wanted 0).
- canonical `cost` ignored: `record().cost === 3`.
- estimated live record: `hardBreach()` fired on $18.
- G-F15 all-unknown markdown was `Estimated cost: $0.0000` (asserted after projection existed).

## GREEN

```
bun test tests/unit/sep8-remediation/r09/ tests/integration/sep8-remediation/r09/ tests/integration/budget-ledger-real-loop-e2e.test.ts tests/unit/budget-ledger-hellgate.test.ts tests/unit/eval-runner-token-cost.test.ts
```

**58 pass / 0 fail.**

Also green: persist/pricing-ssot hellgates, ledger-enforce unit+loop e2e, eval-additive hellgate, budget-pricing-parity, edge-cases, grounding storage roundtrip.

## Mutation

- G-F15: `projectEvalCost` with completeness forced to `complete` on all-unknown renders `$0.0000`; production completeness `unavailable` does not. Test: `MUTATION: stripping completeness…`.
- P1-A-02: deleting `cost: eventCost` from the ledger sink in `emit-helpers.ts` restores audit probe `totalCost=3` + USD stop (the original RED).

## Deleted / moved

- No product path deleted. Hydrate/parse helpers moved from `budget-ledger.ts` into `src/agent/budget-ledger/codec.ts` (same behavior + provenance fields).

## Compatibility

- `TokenCostRollup` 5-field object unchanged (existing `toEqual` suites).
- Direct ledger record without `cost` still bills sonnet fallback for display.
- Legacy `v:1` blobs without provenance: not known; next known tick does not inherit that USD into the hard cap.
- `usage-accounting/index.ts` **not** edited. See UNAPPLIED `integration-delta.md`.

## Unverified / out of scope

- repository `prepush` / global lint-debt / god-code ratchet campaign on a dirty multi-worker tree.
- live `~/.quanta/budget.json` campaign files from before this stamp.
- activating estimated USD enforcement (explicitly off in W0.6).

## Files changed

Source:

- `src/observability/usage-accounting/provenance.ts` (new)
- `src/agent/budget-ledger.ts`
- `src/agent/budget-ledger/canonical-cost.ts` (new)
- `src/agent/budget-ledger/codec.ts` (new)
- `src/agent/loop/emit-helpers.ts`
- `src/agent/loop/stop-conditions.ts`
- `src/apps/eval/report/coverage-matrix.ts`
- `src/apps/eval/report/markdown.ts`
- `src/apps/eval/report/index.ts`

Tests:

- `tests/unit/sep8-remediation/r09/p1-a-02-meter-ledger-policy.test.ts`
- `tests/unit/sep8-remediation/r09/g-f15-eval-cost-completeness.test.ts`
- `tests/integration/sep8-remediation/r09/p1-a-02-emit-usage-loop.test.ts`
- `tests/integration/budget-ledger-real-loop-e2e.test.ts`

Artifacts:

- `docs/plans/sep-8-structural-remediation/work/R09/receipt.md`
- `docs/plans/sep-8-structural-remediation/work/R09/integration-delta.md`
