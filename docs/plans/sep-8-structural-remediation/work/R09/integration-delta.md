# R09 integration delta — UNAPPLIED

Status: **not applied**. Integrator-only. Worker did not edit reserved barrels.

## `src/observability/usage-accounting/index.ts`

Re-export the W0.6 provenance helpers so `@/observability/usage-accounting` consumers do not need a deep path:

```ts
export {
  hydratePricingProvenance,
  livePricingProvenance,
  type PricingProvenance,
  pricingProvenanceOf,
  usdEnforced,
} from "./provenance"
```

Worker imports today: `@/observability/usage-accounting/provenance` (agent ledger) and local eval projection (no barrel needed).

## `tests/unit/observability/usage-accounting-*.test.ts`

No product updates required. Those suites still describe `priceUsage` known/unknown/fallback shapes. Ledger enforcement no longer re-prices unknown `emitUsage` events with `safeFallback`.

## Compatibility notes for I-phase

- `CoverageMatrix.tokenCost` keeps `{prompt,completion,cacheRead,costUsd,records}`. Completeness lives on sibling `costPricing`. Existing `toEqual` on `tokenCost` stays valid.
- `UsageEvent` gained optional `cost` + `pricingProvenance`. v1 JSON with extra fields is backward compatible; missing provenance hydrates as **not known**.
- Direct `ledger.record` without `cost` still displays the sonnet fallback (HELL-3 / HELL-30) as **estimated**; USD hard caps ignore it.
- `src/agent/index.ts` does not re-export `@/agent/budget-ledger`. Optional: re-export `PricingProvenance` from the agent barrel if a public SDK consumer needs it.
