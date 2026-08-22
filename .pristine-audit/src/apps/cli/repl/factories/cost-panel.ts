import { type CostPanel, createCostPanel } from "../../cost-panel"
import type { CliFeatureConfig } from "../cli-feature-config"

/** S3 cost-panel adapter — built ONCE at REPL setup. Returns `undefined` when
 *  the gate refuses (non-TTY / `QUANTA_COST_PANEL=0`) so the surface omits the
 *  `cost` field from `ReplSlashCtx` and `/cost` keeps printing "not wired".
 *  When built, the caller folds per-turn metric DELTAS via
 *  `foldCostPanelDelta` and exposes `panel.renderDetailed` to the slash
 *  command. The metrics counters are CUMULATIVE across the session — we track
 *  the previous snapshot and feed only the delta into `incrementTurn`. */
export const buildCostPanelOrUndefined = (
  featureCfg: CliFeatureConfig,
  model: string,
): CostPanel | undefined => {
  if (!featureCfg.costPanel.enabled) return undefined
  return createCostPanel({ enabled: true, model })
}
