# Sep-08 SE audit — agent-7 (Lane A)

> Scope: `agent`, `activity`, `attention`, `objective`
>
> Fact-check snapshot: `f5f4875799141068af73e604129c8b9a09f76007`
>
> Result: retain 3 issues. Product code was not changed.

## Retained

| ID | Severity | Issue |
|---|---|---|
| P1-A-02 | P1 | an unknown model is non-enforceable in the run meter but enforceable through the ledger's fallback estimate |
| P2-A-02 | P2 | shadow verification permanently caches a transient negative LSP probe |
| P2-A-05 | P2 | diagnostics hook permanently caches transient `null` LSP opens for the session |

### P1-A-02 — unknown-model budget policy divergence

- Evidence: `src/agent/loop/emit-helpers.ts:99-112` skips the run-meter USD tick when `eventCost.pricingKnown` is false, but the next sink re-prices the same event through `budgetLedger.record` at `:121-131`. The ledger substitutes `safeFallback` at `src/agent/budget-ledger.ts:454-475`, checks breaches before returning `pricingKnown:false` at `:697-713`, and `src/agent/loop/stop-conditions.ts:68-88` stops on that hard breach without consulting pricing provenance.
- Trigger: an enabled ledger with a hard USD policy receives usage for a model absent from the rate card.
- Impact: the per-run meter deliberately treats the price as unknown, while the ledger can stop the run using an estimated Sonnet fallback. This contradicts the pricing contract asserted in `tests/unit/observability/usage-accounting-normalize-price.test.ts:11-13` that unknown pricing is not enforced.
- Smallest correction: make breach evaluation ignore `pricingKnown:false`, or define and enforce one explicit estimate policy in both sinks. Add an `emitUsage` rail with an unknown model, both sinks enabled, and a hard limit below the fallback estimate.

### P2-A-02 — shadow LSP negative cache poisoning

- Evidence: canonical availability caching removes settled `false` results at `src/agent/lsp-bridge/availability.ts:47-62`. The shadow adapter independently caches every `Promise<boolean>`, including `false`, at `src/agent/shadow-verify-adapters/check-lsp-test.ts:63-90`.
- Trigger: the first `<bin> --version` probe times out or transiently fails while shadow verification is enabled.
- Impact: later shadow lint/typecheck calls in the process keep skipping the installed server; the normal LSP path re-probes and can recover.
- Smallest correction: delegate to `lspBinaryAvailable`, or mirror success-only caching. Add a false-then-true probe test proving the second call re-probes.

### P2-A-05 — diagnostics `null` cache poisoning

- Evidence: `src/agent/lsp-diagnostics-hook.ts:74-90` caches the in-flight open promise by extension and retains it regardless of `null` or rejection. The production opener returns `null` for a failed availability probe or failed client start at `src/agent/lsp-bridge/diagnostics.ts:33-45`; the lower availability cache intentionally evicts transient `false` at `availability.ts:47-62`.
- Trigger: the first edit for an extension hits a probe timeout or LSP handshake failure while the diagnostics hook is enabled.
- Impact: every later edit of that extension in the session silently skips diagnostics, even after the server becomes available.
- Smallest correction: evict a settled `null`/rejected open promise while preserving in-flight dedup and successful-session reuse. Add a null-then-live opener test to `tests/unit/lsp-diagnostics-hook-hellgate.test.ts`.

## Verification

- `git rev-parse HEAD` → `f5f4875799141068af73e604129c8b9a09f76007`
- Focused baseline: 100 tests passed across session-index, stdout, SQLite, budget, classifier, LSP, and session-registry suites. The passing suites confirm current contracts but do not exercise the retained negative-cache or cross-sink failure injections.
- An ephemeral pricing probe reproduced P1-A-02: the canonical price returned `{pricingKnown:false,totalUsd:0}`, while the ledger returned `{cost:3,pricingKnown:false}` plus a `$1` session hard breach for the same 1M-token unknown-model event.
