/** Canonical usage accounting (MR-01) — normalize once, price once. */
export {
  resolveUsageAccounting,
  type UsageAccountingMode,
  type UsageAccountingResolution,
} from "./activation"
export {
  createUsageAccounting,
  DEFAULT_RETAINED_RECORDS,
  type UsageAccountingOpts,
} from "./authority"
export { normalizeUsage, promptTokensOf, providerOf } from "./normalize"
export type {
  UsageAccountingPort,
  UsageAccountingSnapshot,
  UsageAggregate,
  UsageRecordResult,
  UsageRejection,
} from "./port"
export { type PriceUsageOpts, priceUsage } from "./price"
export {
  type CostSurfaceOffWireShape,
  type CostSurfaceOnWireShape,
  type CostSurfaceView,
  type CostSurfaceViewWireShape,
  costAccountingOffWire,
  costSurfaceView,
  costSurfaceViewWire,
  type ModelCostLine,
} from "./projection"
export {
  hydratePricingProvenance,
  livePricingProvenance,
  type PricingProvenance,
  pricingProvenanceOf,
  usdEnforced,
} from "./provenance"
export type {
  ModelPrice,
  NormalizedUsage,
  Provider,
  RawUsage,
  UsageCost,
  UsageProvenance,
  UsageRecord,
} from "./types"
