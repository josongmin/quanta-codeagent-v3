/**
 * RFC-07 packet G2 — pure failure-facts DOMAIN (mechanically-countable labels).
 *
 * Hellgate rail for `@/observability/failure-taxonomy`: a PURE, consumer-agnostic
 * schema + classifier for the two count-labels the review blessed
 * (`SUBAGENT_OVERSPAWN`, `EXCESSIVE_QUESTIONS`). No ObservationBundle, no report
 * coupling, no LLM-judge — labels are derived only from mechanical EVENT COUNTS
 * measured against caller-supplied thresholds (no calibrated default ships).
 *
 * RED-on-injection: counts at/under threshold yield NO label; unknown/mismatched
 * facts yield `unavailable`, never a partial label set.
 */

import { describe, expect, test } from "bun:test"
import {
  classifyFailureCounts,
  classifyFailureFacts,
  classifyFailureTaxonomy,
  decodeFailureTaxonomyFacts,
  FAILURE_COUNT_EVENT_KINDS,
  FAILURE_COUNT_LABELS,
  FAILURE_TAXONOMY_SCHEMA_VERSION,
  type FailureCountEvent,
  type FailureCountThresholds,
  type FailureTaxonomyFactsV1,
  tallyFailureCounts,
} from "@/observability/failure-taxonomy"

// Explicit thresholds — the domain ships NO calibrated default (measure-first).
// STRICTLY-GREATER-THAN semantics: a count == threshold does NOT emit.
const THRESH: FailureCountThresholds = {
  subagentSpawnThreshold: 3,
  questionCountThreshold: 2,
}

const spawn = (): FailureCountEvent => ({ kind: "subagent_spawn" })
const question = (): FailureCountEvent => ({ kind: "user_question" })

const factsV1 = (over: Partial<FailureTaxonomyFactsV1>): FailureTaxonomyFactsV1 => ({
  schemaVersion: FAILURE_TAXONOMY_SCHEMA_VERSION,
  runId: "run-1",
  attemptId: "attempt-1",
  sourceDigest: "sha256:abc",
  rawCounts: {},
  ...over,
})

describe("tallyFailureCounts — mechanical count from a synthetic event stream", () => {
  test("counts each closed event kind independently", () => {
    const stream: FailureCountEvent[] = [spawn(), question(), spawn(), spawn(), question()]
    expect(tallyFailureCounts(stream)).toEqual({ subagentsSpawned: 3, questionsAsked: 2 })
  })

  test("empty stream yields zero counts (not undefined)", () => {
    expect(tallyFailureCounts([])).toEqual({ subagentsSpawned: 0, questionsAsked: 0 })
  })

  test("the event-kind union is exactly the two mechanically-countable kinds", () => {
    expect([...FAILURE_COUNT_EVENT_KINDS].sort()).toEqual(["subagent_spawn", "user_question"])
  })
})

describe("classifyFailureCounts — the two count-labels, strictly over threshold", () => {
  test("SUBAGENT_OVERSPAWN fires when spawn count exceeds its threshold", () => {
    const counts = tallyFailureCounts([spawn(), spawn(), spawn(), spawn()]) // 4 > 3
    expect(classifyFailureCounts(counts, THRESH)).toContain("SUBAGENT_OVERSPAWN")
  })

  test("EXCESSIVE_QUESTIONS fires when question count exceeds its threshold", () => {
    const counts = tallyFailureCounts([question(), question(), question()]) // 3 > 2
    expect(classifyFailureCounts(counts, THRESH)).toContain("EXCESSIVE_QUESTIONS")
  })

  test("RED-on-injection: counts UNDER threshold yield NO label", () => {
    const counts = tallyFailureCounts([spawn(), spawn(), question()]) // 2<=3, 1<=2
    expect(classifyFailureCounts(counts, THRESH)).toEqual([])
  })

  test("RED-on-injection: count EXACTLY AT threshold yields NO label (strictly greater)", () => {
    const counts = tallyFailureCounts([spawn(), spawn(), spawn(), question(), question()]) // 3,2
    expect(classifyFailureCounts(counts, THRESH)).toEqual([])
  })

  test("both labels emit together, in the canonical FAILURE_COUNT_LABELS order", () => {
    const counts = { subagentsSpawned: 9, questionsAsked: 9 }
    expect(classifyFailureCounts(counts, THRESH)).toEqual([...FAILURE_COUNT_LABELS])
  })

  test("purity/determinism: identical inputs give identical output across calls", () => {
    const counts = { subagentsSpawned: 4, questionsAsked: 4 }
    const a = classifyFailureCounts(counts, THRESH)
    const b = classifyFailureCounts(counts, THRESH)
    expect(a).toEqual(b)
  })

  test("threshold is caller-supplied, not baked: a higher threshold suppresses the label", () => {
    const counts = { subagentsSpawned: 4, questionsAsked: 4 }
    const strict: FailureCountThresholds = {
      subagentSpawnThreshold: 100,
      questionCountThreshold: 100,
    }
    expect(classifyFailureCounts(counts, strict)).toEqual([])
  })
})

describe("classifyFailureFacts — per-detector availability over the fact schema", () => {
  test("complete facts classify deterministically with both detectors present", () => {
    const facts = factsV1({ rawCounts: { subagentsSpawned: 4, questionsAsked: 4 } })
    const c = classifyFailureFacts(facts, THRESH)
    expect(c.labels).toEqual([...FAILURE_COUNT_LABELS])
    expect(c.detectors.SUBAGENT_OVERSPAWN.status).toBe("emitted")
    expect(c.detectors.EXCESSIVE_QUESTIONS.status).toBe("emitted")
  })

  test("count present but below threshold -> below_threshold, no label", () => {
    const facts = factsV1({ rawCounts: { subagentsSpawned: 1, questionsAsked: 1 } })
    const c = classifyFailureFacts(facts, THRESH)
    expect(c.labels).toEqual([])
    expect(c.detectors.SUBAGENT_OVERSPAWN.status).toBe("below_threshold")
    expect(c.detectors.EXCESSIVE_QUESTIONS.status).toBe("below_threshold")
  })

  test("per-detector: an ABSENT required count disables ONLY its detector (unavailable)", () => {
    // subagent count present & over threshold; question count absent entirely.
    const facts = factsV1({ rawCounts: { subagentsSpawned: 4 } })
    const c = classifyFailureFacts(facts, THRESH)
    expect(c.detectors.SUBAGENT_OVERSPAWN.status).toBe("emitted")
    expect(c.detectors.EXCESSIVE_QUESTIONS.status).toBe("unavailable")
    expect(c.labels).toEqual(["SUBAGENT_OVERSPAWN"])
  })
})

describe("decodeFailureTaxonomyFacts — strict, fail-closed decoder", () => {
  test("accepts a well-formed V1 record", () => {
    const decoded = decodeFailureTaxonomyFacts({
      schemaVersion: 1,
      runId: "r",
      attemptId: "a",
      sourceDigest: "d",
      rawCounts: { subagentsSpawned: 5, questionsAsked: 0 },
    })
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.facts.rawCounts.subagentsSpawned).toBe(5)
  })

  test("unknown schema version -> unavailable (never best-effort partial)", () => {
    const decoded = decodeFailureTaxonomyFacts({
      schemaVersion: 2,
      runId: "r",
      attemptId: "a",
      sourceDigest: "d",
      rawCounts: {},
    })
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toBe("unknown_schema_version")
  })

  test("non-record / malformed identity -> unavailable", () => {
    expect(decodeFailureTaxonomyFacts(null).ok).toBe(false)
    expect(decodeFailureTaxonomyFacts([]).ok).toBe(false)
    expect(decodeFailureTaxonomyFacts({ schemaVersion: 1 }).ok).toBe(false) // missing ids
  })

  test("a PRESENT but non-count value (negative / non-integer / NaN) -> malformed", () => {
    const base = { schemaVersion: 1, runId: "r", attemptId: "a", sourceDigest: "d" }
    expect(decodeFailureTaxonomyFacts({ ...base, rawCounts: { subagentsSpawned: -1 } }).ok).toBe(
      false,
    )
    expect(decodeFailureTaxonomyFacts({ ...base, rawCounts: { subagentsSpawned: 1.5 } }).ok).toBe(
      false,
    )
    expect(
      decodeFailureTaxonomyFacts({ ...base, rawCounts: { questionsAsked: Number.NaN } }).ok,
    ).toBe(false)
  })
})

describe("classifyFailureTaxonomy — decode then classify (whole-facts unavailable)", () => {
  test("valid raw -> classified labels", () => {
    const res = classifyFailureTaxonomy(
      {
        schemaVersion: 1,
        runId: "r",
        attemptId: "a",
        sourceDigest: "d",
        rawCounts: { subagentsSpawned: 4, questionsAsked: 0 },
      },
      THRESH,
    )
    expect(res.kind).toBe("classified")
    if (res.kind === "classified") expect(res.classification.labels).toEqual(["SUBAGENT_OVERSPAWN"])
  })

  test("unknown version -> whole result unavailable, NEVER a partial label set", () => {
    const res = classifyFailureTaxonomy({ schemaVersion: 99, rawCounts: {} }, THRESH)
    expect(res.kind).toBe("unavailable")
    if (res.kind === "unavailable") expect(res.reason).toBe("unknown_schema_version")
    // and crucially: no `labels` field leaks through on the unavailable arm
    expect((res as { labels?: unknown }).labels).toBeUndefined()
  })
})
