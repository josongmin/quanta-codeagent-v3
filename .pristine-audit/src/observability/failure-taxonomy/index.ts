/**
 * RFC-07 packet G2 — pure failure-facts DOMAIN barrel.
 *
 * Sub-slice barrel for `@/observability/failure-taxonomy`. Consumer-agnostic and
 * inert until wired: G3 derives `FailureTaxonomyFactsV1` at the live bundle seam,
 * G4 persists it with the attempt, and G5 (BLOCKED on the dirty report owner)
 * maps facts -> labels via this pure classifier at report time.
 */

export {
  classifyFailureCounts,
  classifyFailureFacts,
  classifyFailureTaxonomy,
  decodeFailureTaxonomyFacts,
  tallyFailureCounts,
} from "./classify"
export {
  type DetectorOutcome,
  FAILURE_COUNT_EVENT_KINDS,
  FAILURE_COUNT_LABELS,
  FAILURE_TAXONOMY_SCHEMA_VERSION,
  FAILURE_UNAVAILABLE_REASONS,
  type FailureCountClassification,
  type FailureCountEvent,
  type FailureCountEventKind,
  type FailureCountLabel,
  type FailureCountThresholds,
  type FailureFactsDecode,
  type FailureRawCounts,
  type FailureRawCountsTally,
  type FailureTaxonomyFactsV1,
  type FailureTaxonomyResult,
  type FailureTaxonomySchemaVersion,
  type FailureUnavailableReason,
} from "./types"
