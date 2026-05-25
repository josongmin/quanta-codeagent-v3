# ADR-0274: BudgetProbe — real wire from ADR-0138 budget-ledger to ADR-0265 budget-aware preset

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0138 (token budget ledger — `defaultBudgetLedger().snapshot()`
  cumulative USD source), ADR-0265 (SearchPipeline composer — `budgetAwarePipeline`
  consumes a duck-typed `BudgetProbe` port), ADR-0159 (`@/retrieval` slice fence
  — direct `@/agent/budget-ledger` import forbidden, the adapter accepts a
  duck-typed shape).
- **References**:
  - `src/retrieval/budget-probe/port.ts` — broadened `BudgetProbe { usdSoFar();
    maxAllowed(); remaining() }` (structural superset of the pipeline's
    `usdSoFar()`-only port).
  - `src/retrieval/budget-probe/types.ts` — `BudgetProbeError` 3-arm closed
    union (`ledger-unavailable`, `invalid-budget`, `budget-exceeded`).
  - `src/retrieval/budget-probe/from-ledger.ts` — `createBudgetProbeFromLedger(
    ledger, { maxUsd })` adapter; ledger is duck-typed `{ snapshot(): { totalUsd:
    number } }`, the slice fence stays honest.
  - `src/retrieval/budget-probe/static-probe.ts` — `createStaticBudgetProbe({
    usdSoFar, maxAllowed })` for tests + dev sandboxing.
  - `src/retrieval/budget-probe/index.ts` — sub-barrel.
  - `tests/unit/retrieval/budget-probe-hellgate.test.ts` — 12 adversarial cases
    (HELL-BP-01 … HELL-BP-12).

## Context

ADR-0265 ships `budgetAwarePipeline({ inner, maxUsd, probe })`. The `probe`
is a duck-typed `BudgetProbe { usdSoFar(): number }` port — the composer
never imports `@/agent/budget-ledger` because the slice fence (ADR-0159)
forbids `@/retrieval` → `@/agent` edges. Today NO file in the repo
constructs a `BudgetProbe`, which means the budget-aware preset is
default-OFF *and* genuinely a no-op at every assembly site that might
adopt it — the integration the ADR-0265 §"Budget-gate integration"
example sketched (`probe: { usdSoFar: () => ledger.snapshot().totalUsd }`)
has nowhere to live.

The reason it could not live in `@/retrieval/pipeline/` is the fence; the
reason it could not live in `@/agent/budget-ledger.ts` is the inverse
fence (a retrieval-shaped adapter would leak retrieval vocabulary into
the ledger). The natural home is a NEW sub-slice
`src/retrieval/budget-probe/` whose only dependency is a duck-typed
ledger shape — neither end imports the other.

## Decision

Ship `src/retrieval/budget-probe/` with three factories and one error union:

1. **`BudgetProbe` port** (`port.ts`) — broadened to
   `{ usdSoFar(); maxAllowed(); remaining() }`. The pipeline's narrower
   `{ usdSoFar() }` port is a structural subset, so any `BudgetProbe`
   produced here is accepted by `budgetAwarePipeline` without a cast.
   The two extra accessors let surfaces (status bars, panels, future
   tools) read the budget without re-deriving math at every callsite.
2. **`createBudgetProbeFromLedger(ledger, { maxUsd })`** (`from-ledger.ts`)
   — duck-typed adapter. `ledger` is the structural shape
   `{ snapshot(): { totalUsd: number } }`. The adapter NEVER imports
   `@/agent/budget-ledger`; callers at the assembly site pass
   `{ snapshot: () => ({ totalUsd: ledger.snapshot().totalCost }) }` if
   they want to bridge the real ledger's `totalCost` accessor.
   - `maxUsd === 0` → `remaining()` always 0 (always budget-exceeded).
   - `maxUsd < 0` → factory throws `BudgetProbeError("invalid-budget")`
     at construction (closed-port, fail-fast; we will not silently
     accept an unsatisfiable budget).
   - `ledger.snapshot()` failure → `usdSoFar()` throws
     `BudgetProbeError("ledger-unavailable", cause)`; callers may catch
     and fall back to a static probe.
3. **`createStaticBudgetProbe({ usdSoFar, maxAllowed })`** (`static-probe.ts`)
   — pure constant-valued probe for tests and dev sandboxing. No ledger,
   no I/O. `maxAllowed <= 0` is allowed (callers test boundary cases).
4. **`BudgetProbeError`** (`types.ts`) — 3-arm closed discriminated union:
   `ledger-unavailable | invalid-budget | budget-exceeded`. The
   `budget-exceeded` arm mirrors the pipeline's `PipelineError`
   `budget-exceeded` shape; surfaces that bridge the two see one vocabulary.

### Default-OFF

The new sub-slice ships NO assembly wiring. The agent root remains
byte-identical until a caller imports `createBudgetProbeFromLedger` and
passes the result into `budgetAwarePipeline`. HELL-BP-09 enforces this
via a source-text grep against `from "@/retrieval/budget-probe"` in
`src/{agent,runner,apps}`.

### Slice-fence posture

The adapter accepts `ledger` as a structural `{ snapshot(): { totalUsd:
number } }` shape — NOT a typed `BudgetLedger` import. This is the same
duck-typed seam ADR-0265 uses for `BudgetProbe` itself. A future move
of `budget-ledger.ts` (rename / reshape) does not break this slice.

## Alternatives rejected

1. **Wire directly inside `@/agent/budget-ledger.ts`.** Would force the
   ledger to know about retrieval vocabulary (`BudgetProbe`, `maxUsd`)
   it has no reason to know. The fence is bidirectional.
2. **Make `BudgetProbe` mutable (allow `setUsdSoFar`).** Rejected — the
   probe is observational, not authoritative. Callers that need to
   mutate budget state do so via the ledger's `record()`. The probe
   simply reflects.
3. **Throw `Result` instead of a thrown error.** `usdSoFar()` is called
   inside the pipeline's budget-gate stage which already wraps its
   return in `Result`; the simplest seam is a throw inside the probe +
   `try/catch` at the gate. The hellgate (HELL-BP-06) locks this so
   the throw path stays explicit.

## Hellgate

`tests/unit/retrieval/budget-probe-hellgate.test.ts` ships 12 adversarial cases:

| ID | Invariant |
|----|-----------|
| HELL-BP-01 | `createBudgetProbeFromLedger(mockLedger).usdSoFar()` returns the ledger's `totalUsd` |
| HELL-BP-02 | `maxAllowed()` returns the configured `maxUsd` |
| HELL-BP-03 | `remaining()` equals `maxAllowed() - usdSoFar()` |
| HELL-BP-04 | `remaining()` clamped to 0 when `usdSoFar > maxAllowed` (never negative) |
| HELL-BP-05 | `createStaticBudgetProbe` returns configurable values verbatim |
| HELL-BP-06 | ledger.snapshot() that throws → `BudgetProbeError("ledger-unavailable")` |
| HELL-BP-07 | `maxUsd === 0` → `remaining()` always 0 (always budget-exceeded) |
| HELL-BP-08 | `maxUsd < 0` → factory throws `BudgetProbeError("invalid-budget")` |
| HELL-BP-09 | default-OFF — no `from "@/retrieval/budget-probe"` in `src/{agent,runner,apps}` |
| HELL-BP-10 | concurrent `usdSoFar()` calls return identical values (no race in adapter) |
| HELL-BP-11 | 1000 `usdSoFar()` calls finish in < 50 ms (perf sanity) |
| HELL-BP-12 | `BudgetProbeError` is a 3-arm closed union (TS `never` on missing arm) |

## Consequences

- **+** ADR-0265's `budgetAwarePipeline` is now a usable seam: callers
  bridge a real `BudgetLedger` to a typed budget gate without crossing
  the slice fence.
- **+** Three-method probe is structurally compatible with the pipeline's
  one-method port — no double-port maintenance.
- **+** Closed `BudgetProbeError` union keeps callsites exhaustive at
  compile time.
- **−** Two probes (static + ledger-bridged) double the surface
  area slightly. The static probe is the test seam; the ledger one is
  the production seam — both ship in `index.ts` so callers don't
  invent ad-hoc subclasses.
- **−** `usdSoFar()` throws on ledger failure rather than returning a
  Result. This is the trade-off documented in alternative #3 — the
  pipeline gate catches at its own boundary.
