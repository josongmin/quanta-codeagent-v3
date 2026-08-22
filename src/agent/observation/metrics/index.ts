/**
 * Observation metrics — Stream S4 barrel (jul-6). Pure, observe-only USAGE /
 * OVERTRUST rails derived from one instance's trajectory + observation bundle.
 * Design SSOT: `docs/plans/jul-6-observation-providers/README.md` §실험 설계.
 */

export {
  EDIT_TOOLS,
  type MetricEvent,
  type MetricEventKind,
  NON_FILE_VERIFY_TOOLS,
  pathMatchesAnyOwner,
  pathMatchesOwner,
  READ_TOOLS,
  toolFilePath,
  toolName,
  VERIFY_TOOLS,
} from "./event"
export {
  adaptFailureCountEvents,
  computeFailureSourceDigest,
  extractFailureFacts,
  FAILURE_FACTS_UNAVAILABLE_REASONS,
  type FailureFactsExtraction,
  type FailureFactsIdentity,
  type FailureFactsMismatch,
  type FailureFactsUnavailableReason,
  type LiveFailureObservation,
} from "./failure-facts"
export {
  classifyFailure,
  type FailureLabel,
  type TaxonomyOptions,
} from "./failure-taxonomy"
export { type StratumInput, type StratumTag, stratumTag } from "./stratum"
export {
  bundleOwnerPaths,
  type CriticObservation,
  criticSavedEditRate,
  hintFollowWithoutVerifyRate,
  hintReadRate,
  hintVerifyRate,
  type MetricInputs,
  makeRate,
  ownerEditHitRate,
  type Rate,
  wrongOwnerEditRate,
} from "./usage-metrics"
