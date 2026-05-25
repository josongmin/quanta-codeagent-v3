/**
 * BudgetProbe port (ADR-0274).
 *
 * Broadened observational probe over a caller-supplied USD spend source.
 * The pipeline composer (ADR-0265) defines a narrower `BudgetProbe`
 * (`{ usdSoFar(): number }` only) — this broader shape is a STRUCTURAL
 * SUPERSET, so any probe returned from this sub-slice passes the
 * pipeline's port unchanged.
 *
 * Observational, not authoritative — every accessor returns a value but
 * NEVER mutates the underlying source. Callers that need to mutate the
 * budget call the ledger directly (`BudgetLedger.record(...)`); this
 * port simply reflects.
 *
 * Slice fence (ADR-0159): this file imports nothing from `@/agent`,
 * `@/llm`, `@/observability` — pure leaf type declaration. The adapter
 * in `from-ledger.ts` accepts a duck-typed ledger shape; it never
 * imports the real `BudgetLedger` interface.
 */

/**
 * Read-only spend probe.
 *
 * Contract:
 *   - `usdSoFar()` returns the cumulative USD spent so far. MAY throw
 *     `BudgetProbeError("ledger-unavailable")` if the underlying source
 *     (e.g. a ledger snapshot) is unavailable — see `from-ledger.ts`.
 *     The pipeline's budget-gate stage catches at its boundary.
 *   - `maxAllowed()` returns the configured cap in USD. Constant across
 *     calls. Always >= 0 — the factory rejects negative caps at
 *     construction (`invalid-budget`).
 *   - `remaining()` returns `max(0, maxAllowed() - usdSoFar())`. Clamped
 *     to 0 so an over-budget probe still reports a non-negative number
 *     (useful for status-bar rendering).
 */
export interface BudgetProbe {
  usdSoFar(): number
  maxAllowed(): number
  remaining(): number
}
