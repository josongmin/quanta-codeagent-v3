/**
 * BudgetProbe error taxonomy (ADR-0274).
 *
 * 3-arm closed discriminated union. Adding a 4th arm forces every
 * exhaustive switch in the codebase to acquire the missing branch —
 * TypeScript reports `never` mismatch at any consumer that fails to
 * update. The runtime mirror in `BudgetProbeError`'s default branches
 * is enforced by HELL-BP-12.
 *
 * Each arm carries the minimum context needed to act:
 *   - `ledger-unavailable` — the ledger snapshot threw; `cause` is the
 *     original error so callers can re-raise / log.
 *   - `invalid-budget` — the factory's `maxUsd` was negative (we do not
 *     silently accept an unsatisfiable budget); `reason` describes the
 *     offending value.
 *   - `budget-exceeded` — observational; matches the pipeline composer's
 *     `PipelineError("budget-exceeded")` shape so a bridge between the
 *     two surfaces sees one vocabulary.
 */
export type BudgetProbeError =
  | { kind: "ledger-unavailable"; cause: unknown }
  | { kind: "invalid-budget"; reason: string }
  | { kind: "budget-exceeded"; maxUsd: number; usdSoFar: number }

/**
 * Thrown wrapper. `Error.name === "BudgetProbeError"` so callers can
 * `instanceof`-check OR `err.name === "BudgetProbeError"` distinguish.
 * The `kind` field carries the closed union — callers should exhaustive-
 * switch on it.
 */
export class BudgetProbeException extends Error {
  override readonly name = "BudgetProbeError"
  readonly kind: BudgetProbeError["kind"]
  readonly detail: BudgetProbeError

  constructor(detail: BudgetProbeError) {
    super(messageFor(detail))
    this.detail = detail
    this.kind = detail.kind
  }
}

const messageFor = (detail: BudgetProbeError): string => {
  switch (detail.kind) {
    case "ledger-unavailable":
      return "BudgetProbe: ledger snapshot unavailable"
    case "invalid-budget":
      return `BudgetProbe: invalid budget — ${detail.reason}`
    case "budget-exceeded":
      return `BudgetProbe: budget exceeded — usdSoFar=${detail.usdSoFar} maxUsd=${detail.maxUsd}`
  }
}
