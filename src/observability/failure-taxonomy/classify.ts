/**
 * RFC-07 packet G2 — pure failure-facts DOMAIN (classifier + strict decoder).
 *
 * Pure, deterministic, IO-free. Imports only `@/shared` primitives. No
 * `ObservationBundle`, no report, no `@/llm` — labels are mechanical event
 * counts vs caller-supplied thresholds. See `./types` for the schema/contract.
 */

import { assertNever, isRecord } from "@/shared"
import {
  type DetectorOutcome,
  FAILURE_COUNT_LABELS,
  FAILURE_TAXONOMY_SCHEMA_VERSION,
  type FailureCountClassification,
  type FailureCountEvent,
  type FailureCountLabel,
  type FailureCountThresholds,
  type FailureFactsDecode,
  type FailureRawCounts,
  type FailureRawCountsTally,
  type FailureTaxonomyFactsV1,
  type FailureTaxonomyResult,
} from "./types"

/** Tally a synthetic/real count-event stream into raw counts. Both counts are
 *  always defined (0 when the kind never appears) — this is the mechanical,
 *  non-judgemental measurement the count-labels are built on. */
export const tallyFailureCounts = (events: readonly FailureCountEvent[]): FailureRawCountsTally => {
  let subagentsSpawned = 0
  let questionsAsked = 0
  for (const event of events) {
    switch (event.kind) {
      case "subagent_spawn":
        subagentsSpawned++
        break
      case "user_question":
        questionsAsked++
        break
      default:
        assertNever(event.kind, "FailureCountEventKind")
    }
  }
  return { subagentsSpawned, questionsAsked }
}

/** One detector: strictly-greater-than the threshold emits; a present-but-low
 *  count is `below_threshold`; an ABSENT count is `unavailable`. */
const detectorOutcome = (count: number | undefined, threshold: number): DetectorOutcome => {
  if (count === undefined) return { status: "unavailable" }
  return count > threshold ? { status: "emitted" } : { status: "below_threshold" }
}

/** Classify a fact record's counts into per-detector outcomes + emitted labels.
 *  The `detectors` map is an exhaustive `Record<FailureCountLabel, …>` literal,
 *  so a new label cannot compile until it is classified here. */
export const classifyFailureFacts = (
  facts: FailureTaxonomyFactsV1,
  thresholds: FailureCountThresholds,
): FailureCountClassification => {
  const detectors: Record<FailureCountLabel, DetectorOutcome> = {
    SUBAGENT_OVERSPAWN: detectorOutcome(
      facts.rawCounts.subagentsSpawned,
      thresholds.subagentSpawnThreshold,
    ),
    EXCESSIVE_QUESTIONS: detectorOutcome(
      facts.rawCounts.questionsAsked,
      thresholds.questionCountThreshold,
    ),
  }
  // Deterministic order: the canonical label union order.
  const labels = FAILURE_COUNT_LABELS.filter((label) => detectors[label].status === "emitted")
  return { labels, detectors }
}

/** Convenience over a fully-known tally (both counts present) — returns just the
 *  emitted labels in canonical order. */
export const classifyFailureCounts = (
  counts: FailureRawCounts,
  thresholds: FailureCountThresholds,
): readonly FailureCountLabel[] =>
  classifyFailureFacts(
    {
      schemaVersion: FAILURE_TAXONOMY_SCHEMA_VERSION,
      runId: "",
      attemptId: "",
      sourceDigest: "",
      rawCounts: counts,
    },
    thresholds,
  ).labels

/** A finite, non-negative integer — the only admissible shape of a raw count. */
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

/** Validate an OPTIONAL raw-count field: absent is allowed (per-detector
 *  unavailable downstream); present-but-not-a-count is malformed. */
const decodeOptionalCount = (
  value: unknown,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false } => {
  if (value === undefined) return { ok: true, value: undefined }
  if (isCount(value)) return { ok: true, value }
  return { ok: false }
}

/**
 * Strict, fail-closed decoder for a persisted fact record. Unknown schema
 * version -> `unknown_schema_version`; any structural/identity/count malformation
 * -> `malformed_facts`. Never returns a best-effort partial.
 */
export const decodeFailureTaxonomyFacts = (raw: unknown): FailureFactsDecode => {
  if (!isRecord(raw)) return { ok: false, reason: "malformed_facts" }
  if (raw.schemaVersion !== FAILURE_TAXONOMY_SCHEMA_VERSION) {
    return { ok: false, reason: "unknown_schema_version" }
  }
  const { runId, attemptId, sourceDigest, rawCounts } = raw
  if (
    typeof runId !== "string" ||
    typeof attemptId !== "string" ||
    typeof sourceDigest !== "string"
  ) {
    return { ok: false, reason: "malformed_facts" }
  }
  if (!isRecord(rawCounts)) return { ok: false, reason: "malformed_facts" }
  const spawned = decodeOptionalCount(rawCounts.subagentsSpawned)
  const asked = decodeOptionalCount(rawCounts.questionsAsked)
  if (!spawned.ok || !asked.ok) return { ok: false, reason: "malformed_facts" }
  const rawCountsDecoded: FailureRawCounts = {
    ...(spawned.value !== undefined ? { subagentsSpawned: spawned.value } : {}),
    ...(asked.value !== undefined ? { questionsAsked: asked.value } : {}),
  }
  return {
    ok: true,
    facts: {
      schemaVersion: FAILURE_TAXONOMY_SCHEMA_VERSION,
      runId,
      attemptId,
      sourceDigest,
      rawCounts: rawCountsDecoded,
    },
  }
}

/** Decode a persisted raw record then classify it. A whole-facts failure
 *  collapses to a single `unavailable` (never a partial label set). */
export const classifyFailureTaxonomy = (
  raw: unknown,
  thresholds: FailureCountThresholds,
): FailureTaxonomyResult => {
  const decoded = decodeFailureTaxonomyFacts(raw)
  if (!decoded.ok) return { kind: "unavailable", reason: decoded.reason }
  return { kind: "classified", classification: classifyFailureFacts(decoded.facts, thresholds) }
}
