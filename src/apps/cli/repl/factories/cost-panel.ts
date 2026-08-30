import type { UsageAccountingPort } from "@/observability/usage-accounting"
import { type CostPanel, createCostPanel } from "../../cost-panel"
import type { CliFeatureConfig } from "../cli-feature-config"

/** Cost-panel adapter — built ONCE at REPL setup. Returns `undefined` when
 *  the gate refuses (non-TTY / `QUANTA_COST_PANEL=0`) so the surface omits the
 *  `cost` field from `ReplSlashCtx` and `/cost` keeps printing "not wired".
 *  A3 — the panel is a pure projection of the usage-accounting authority (its
 *  only per-turn input is `noteTurn()` from the dashboard sink); the legacy
 *  counter-delta fold and its tee are gone. */
export const buildCostPanelOrUndefined = (
  featureCfg: CliFeatureConfig,
  model: string,
  accounting?: UsageAccountingPort,
  /** `false` ⇒ shadow: the authority is handed over so `/cost` can print a
   *  reconciliation receipt, but the panel still renders the legacy feed. */
  accountingAuthoritative = true,
): CostPanel | undefined => {
  if (!featureCfg.costPanel.enabled) return undefined
  // MR-04/MR-08 — an authority in `on` makes the panel PROJECT it; in `shadow`
  // the same object arrives but only feeds the receipt; with none the panel
  // accumulates from the counter delta exactly as before. The composition root
  // decides which, so the switchover is one wire rather than a rewrite.
  return createCostPanel({
    enabled: true,
    model,
    ...(accounting !== undefined ? { accounting, accountingAuthoritative } : {}),
  })
}
