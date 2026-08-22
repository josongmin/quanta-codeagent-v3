/**
 * RFC-07 packet G2 — pure failure-facts DOMAIN (schema).
 *
 * A versioned, JSON-safe fact contract plus the two MECHANICALLY-COUNTABLE
 * failure labels the review blessed. This module is a pure, consumer-agnostic
 * leaf: it owns NO `ObservationBundle` dependency, NO report coupling, and NO
 * LLM-judge. Labels derive only from event COUNTS against caller-supplied
 * thresholds. Bundle-dependent detectors (LOCALIZATION_WRONG_OWNER, …) stay in
 * `@/agent/observation/metrics` and are DEFERRED here (need the live bundle).
 *
 * Architecture SSOT: `docs/plans/aug-22-흡수계획/rfc-07-observability-signals-parity.md`
 * (Executable packet G2) + `00-architecture-blueprint.md` §5 RFC-07.
 */

/** The persisted fact schema version. A strict decoder rejects any other value
 *  (unknown version -> `unavailable`, never a best-effort partial label set). */
export const FAILURE_TAXONOMY_SCHEMA_VERSION = 1 as const
export type FailureTaxonomySchemaVersion = typeof FAILURE_TAXONOMY_SCHEMA_VERSION

/** The two mechanically-countable labels. Closed union; consumers store these
 *  verbatim. Adding a value forces a compile error at every `Record<…>` map. */
export const FAILURE_COUNT_LABELS = ["SUBAGENT_OVERSPAWN", "EXCESSIVE_QUESTIONS"] as const
export type FailureCountLabel = (typeof FAILURE_COUNT_LABELS)[number]

/** The minimal, consumer-agnostic count-event kinds the domain tallies. G3 will
 *  adapt real trajectory/metric events into this CLOSED shape at the live seam;
 *  the domain never imports the agent event type (slice fence). */
export const FAILURE_COUNT_EVENT_KINDS = ["subagent_spawn", "user_question"] as const
export type FailureCountEventKind = (typeof FAILURE_COUNT_EVENT_KINDS)[number]
export interface FailureCountEvent {
  readonly kind: FailureCountEventKind
}

/**
 * Raw mechanical counts. Both fields are OPTIONAL by design: a producer that did
 * not observe/record a given signal leaves its field ABSENT, which disables only
 * that detector (an explicit per-detector `unavailable`), never a fabricated 0.
 * A stream-derived tally, by contrast, always sets both (0 when none seen).
 */
export interface FailureRawCounts {
  readonly subagentsSpawned?: number
  readonly questionsAsked?: number
}

/** Tally over a full event stream — both counts are always defined. */
export interface FailureRawCountsTally {
  readonly subagentsSpawned: number
  readonly questionsAsked: number
}

/**
 * The versioned, JSON-safe per-attempt fact record. Bounded primitives only —
 * no bundle, no free-form model text. Persisted inline with the attempt result
 * under matching `{runId,attemptId,sourceDigest,schemaVersion}` (G4).
 */
export interface FailureTaxonomyFactsV1 {
  readonly schemaVersion: FailureTaxonomySchemaVersion
  readonly runId: string
  readonly attemptId: string
  readonly sourceDigest: string
  readonly rawCounts: FailureRawCounts
}

/**
 * Threshold knobs — EXPLICIT and caller-supplied so no magic/uncalibrated
 * number hides in a branch. A count STRICTLY GREATER THAN its threshold emits
 * the label. The domain ships no default: until task-complexity/policy
 * calibration exists, the caller must provide the thresholds (measure-first).
 */
export interface FailureCountThresholds {
  readonly subagentSpawnThreshold: number
  readonly questionCountThreshold: number
}

/** Per-detector outcome. `unavailable` means the required count field was absent
 *  from the facts — the detector could not run (distinct from `below_threshold`,
 *  where a real count did not clear the bar). */
export type DetectorOutcome =
  | { readonly status: "emitted" }
  | { readonly status: "below_threshold" }
  | { readonly status: "unavailable" }

/** The classification of one fact record: emitted labels plus a total,
 *  exhaustive per-detector map (the `Record` key set is the closed label union,
 *  so a new label is a compile error until it is classified). */
export interface FailureCountClassification {
  readonly labels: readonly FailureCountLabel[]
  readonly detectors: Record<FailureCountLabel, DetectorOutcome>
}

/** Whole-facts unavailability reasons (decode-time, fail-closed). */
export const FAILURE_UNAVAILABLE_REASONS = ["unknown_schema_version", "malformed_facts"] as const
export type FailureUnavailableReason = (typeof FAILURE_UNAVAILABLE_REASONS)[number]

/** Strict-decode result. */
export type FailureFactsDecode =
  | { readonly ok: true; readonly facts: FailureTaxonomyFactsV1 }
  | { readonly ok: false; readonly reason: FailureUnavailableReason }

/** Top-level decode-then-classify result. A whole-facts failure (bad version /
 *  malformed record) collapses to a single `unavailable` — NEVER a partial
 *  label set. Per-detector unavailability lives inside `classification`. */
export type FailureTaxonomyResult =
  | { readonly kind: "classified"; readonly classification: FailureCountClassification }
  | { readonly kind: "unavailable"; readonly reason: FailureUnavailableReason }
