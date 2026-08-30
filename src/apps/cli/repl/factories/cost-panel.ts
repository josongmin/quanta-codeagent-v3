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
): CostPanel | undefined => {
  if (!featureCfg.costPanel.enabled) return undefined
  // A3 — an authority makes the panel PROJECT it; none makes it render an
  // explicit "accounting off". There is no third feed.
  return createCostPanel({
    enabled: true,
    model,
    ...(accounting !== undefined ? { accounting } : {}),
  })
}
