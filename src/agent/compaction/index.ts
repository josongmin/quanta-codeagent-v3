/**
 * Background (speculative) compaction slice — public surface (ADR-0473).
 *
 * Re-exports the controller + its pure predicates + the typed port/config/
 * outcome shapes. Importers get a single entry (`@/agent/compaction`) without
 * reaching into file layout. The slice imports `@/shared` ONLY; the summarize
 * primitive + clock are INJECTED (port inversion). DEFAULT-OFF via the gate
 * `bgCompactionEnabled` (QUANTA_BG_COMPACTION === "1").
 */

export {
  BackgroundSummarizationController,
  bgCompactionEnabled,
  isApproachingLimit,
  meetsPersistThreshold,
  stepHeadroomLatch,
} from "./background"
export {
  BG_COMPACTION_ENV,
  type BgCompactionConfig,
  type CancelToken,
  type Clock,
  type DiscardReason,
  type HeadroomCrossing,
  type HeadroomLatchState,
  type ReconcileOutcome,
  type SpeculativeSummarizeFn,
  type SummarizeError,
  type UsageSnapshot,
} from "./types"
