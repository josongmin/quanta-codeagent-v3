/**
 * PMX-03/04 — COVERAGE HONESTY at the four boundaries that were shrinking the
 * denominator (aug-22 audit).
 *
 * The rule every test below enforces is one rule: *a smaller valid denominator
 * must never make a run look better without the coverage loss being visible.*
 * Its four leaks were all of the same shape — a path where something went WRONG
 * fell back to a number computed on the assumption that nothing had:
 *
 *   C2  a REFUSED campaign merge returned the relaunch retry set, which had
 *       already counted the now-refused receipts as coverage;
 *   C3  a receipt document with no `evaluator` key threw a TypeError instead of
 *       returning the typed refusal, so three real paths crashed rather than
 *       failing closed;
 *   C4  the persisted read boundary never cross-checked `missing_instance_ids`
 *       or `instances` against the totals it validated;
 *   C5  a chunk merge dropped the chunk's declared instance set and, when
 *       refused, discarded the typed failure codes with it.
 *
 * ⚠️ SPEND SAFETY. Pure functions and injected fakes only — no ssh, no Docker,
 * no EC2, nothing that can provision or bill.
 */
import { describe, expect, test } from "bun:test"
import { receiveOfficialGradeReceipt } from "@/apps/bench/remote/box-session/official-grade-transport"
import {
  accumulateChunkCoverage,
  chunkCoverageResult,
  createChunkCoverageAccumulator,
} from "@/apps/bench/remote/pool/coverage"
import type { PoolChunk } from "@/apps/bench/remote/pool/types"
import { resolveRelaunchCoverage } from "@/apps/bench/remote/relaunch-coverage"
import {
  buildOfficialGradeReceipt,
  deriveMissingInstanceIds,
  type OfficialGradeDisposition,
  type OfficialGradeReceipt,
  parseOfficialGradeReceipt,
} from "@/runner/batch/eval/official-grade"
import { decodeOfficialGradeSection } from "@/runner/batch/report-official-grade"
import { evaluatorMeta, OUTPUT_PATH, oracleSha256 } from "./promax-official-fixtures"

const artifact = { path: OUTPUT_PATH, sha256: oracleSha256("doc"), byteLength: 3 }

const dispo = (
  id: string,
  state: "resolved" | "model_miss" = "resolved",
): OfficialGradeDisposition =>
  ({
    instanceId: id,
    state,
    reason: state === "resolved" ? "official_resolved" : "test_failed",
    gradingValid: true,
    rawArtifact: artifact,
    evaluator: { passed: null, model: null, golden: null },
  }) as OfficialGradeDisposition

const receiptOf = (
  assigned: readonly string[],
  dispositions: readonly OfficialGradeDisposition[],
  evaluator = evaluatorMeta(),
): OfficialGradeReceipt => {
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    dispositions,
    evaluator,
  })
  if (!built.ok) throw new Error(`fixture receipt refused: ${JSON.stringify(built.failures)}`)
  return built.receipt
}

// ---------------------------------------------------------------------------
// C2 — a REFUSED merge may not fabricate coverage
// ---------------------------------------------------------------------------

describe("C2 — a refused campaign merge reports the whole gap", () => {
  const EXPECTED = ["i-1", "i-2", "i-3"]

  /** Two attempts that BOTH graded i-1 — a duplicate disposition across the
   *  campaign, which is exactly what `mergeOfficialGradeReceipts` fails closed on. */
  const conflicting = (): readonly OfficialGradeReceipt[] => [
    receiptOf(["i-1", "i-2"], [dispo("i-1"), dispo("i-2")]),
    receiptOf(["i-1"], [dispo("i-1", "model_miss")]),
  ]

  test("PAIRED CONTROL: a merge that SUCCEEDS derives missing from the receipt", () => {
    const coverage = resolveRelaunchCoverage({
      expected: EXPECTED,
      receipts: [receiptOf(["i-1", "i-2"], [dispo("i-1"), dispo("i-2")])],
      legacyMissing: [],
      legacyCovered: [],
    })
    expect(coverage.officialGradeFailures).toBeUndefined()
    expect(coverage.missing).toEqual(["i-3"])
    if (coverage.officialGrade === undefined) throw new Error("expected a merged receipt")
    expect(deriveMissingInstanceIds(coverage.officialGrade)).toEqual(["i-3"])
  })

  test("a REFUSED merge counts NOTHING the refused receipts said as coverage", () => {
    const coverage = resolveRelaunchCoverage({
      expected: EXPECTED,
      receipts: conflicting(),
      // The retry set the relaunch loop computed: it treated i-1 and i-2 as
      // covered BECAUSE the receipts said so — the receipts that just refused.
      legacyMissing: ["i-3"],
      // What the four legacy buckets alone can vouch for: nothing.
      legacyCovered: [],
    })
    expect(coverage.officialGradeFailures?.map((f) => f.code)).toEqual(["disposition_duplicated"])
    // All three, not just i-3: no instance has a disposition this campaign can use.
    expect(coverage.missing).toEqual(EXPECTED)
  })

  test("a refused merge still credits coverage the LEGACY buckets earned on their own", () => {
    // Non-vacuity for the clause above: `missing` is not simply "everything" on
    // a refusal — it is assigned minus what is still vouched for.
    const coverage = resolveRelaunchCoverage({
      expected: EXPECTED,
      receipts: conflicting(),
      legacyMissing: ["i-3"],
      legacyCovered: ["i-2"],
    })
    expect(coverage.missing).toEqual(["i-1", "i-3"])
  })

  test("a family that carried NO receipt is byte-identical to the legacy answer", () => {
    const coverage = resolveRelaunchCoverage({
      expected: EXPECTED,
      receipts: [],
      legacyMissing: ["i-3"],
      legacyCovered: ["i-1", "i-2"],
    })
    expect(coverage).toEqual({ missing: ["i-3"] })
  })
})

// ---------------------------------------------------------------------------
// C3 — an absent `evaluator` fails CLOSED on all three paths
// ---------------------------------------------------------------------------

describe("C3 — a receipt with no evaluator is refused, never crashed on", () => {
  const dispositions = [{ ...dispo("i-1") }]

  const documentWithout = (evaluator: unknown): unknown => ({
    schema_version: 1,
    assignedInstanceIds: ["i-1"],
    dispositions,
    ...(evaluator === undefined ? {} : { evaluator }),
  })

  const ABSENT: readonly [string, unknown][] = [
    ["absent", undefined],
    ["null", null],
    ["a string", "python test_run.py"],
    ["an array", []],
  ]

  test("PATH 1 — buildOfficialGradeReceipt", () => {
    for (const [label, evaluator] of ABSENT) {
      const built = buildOfficialGradeReceipt({
        assignedInstanceIds: ["i-1"],
        dispositions,
        evaluator: evaluator as never,
      })
      expect({ label, ok: built.ok }).toEqual({ label, ok: false })
      if (built.ok) throw new Error("unreachable")
      expect(built.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
    }
  })

  test("PATH 2 — parseOfficialGradeReceipt (the persisted document)", () => {
    for (const [label, evaluator] of ABSENT) {
      const parsed = parseOfficialGradeReceipt(documentWithout(evaluator))
      expect({ label, ok: parsed.ok }).toEqual({ label, ok: false })
      if (parsed.ok) throw new Error("unreachable")
      expect(parsed.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
    }
  })

  test("PATH 3 — the box transport", async () => {
    for (const [label, evaluator] of ABSENT) {
      const outcome = await receiveOfficialGradeReceipt({
        fetch: async () => ({
          code: 0,
          stdout: JSON.stringify(documentWithout(evaluator)),
          stderr: "",
        }),
        remotePath: "~/official-grade-receipt.json",
      })
      expect({ label, ok: outcome.ok }).toEqual({ label, ok: false })
      if (outcome.ok) throw new Error("unreachable")
      if (outcome.code !== "receipt_rejected") throw new Error(`wrong code: ${outcome.code}`)
      expect(outcome.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
    }
  })

  test("PAIRED CONTROL: a complete evaluator is still accepted on every path", async () => {
    const doc = documentWithout(evaluatorMeta())
    expect(parseOfficialGradeReceipt(doc).ok).toBe(true)
    const outcome = await receiveOfficialGradeReceipt({
      fetch: async () => ({ code: 0, stdout: JSON.stringify(doc), stderr: "" }),
      remotePath: "~/official-grade-receipt.json",
    })
    expect(outcome.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C4 — the persisted read boundary cross-checks its own partition
// ---------------------------------------------------------------------------

describe("C4 — decodeOfficialGradeSection refuses a drifted section", () => {
  /** The campaign row. `by_language` mirrors it so the pre-existing partition
   *  checks pass and the NEW cross-checks are what a test is exercising. */
  const languageRow = (over: Record<string, unknown> = {}) => ({
    assigned: 4,
    attempted: 3,
    grading_valid: 2,
    resolved: 1,
    model_miss: 1,
    infra_invalid: 1,
    ambiguous: 0,
    missing: 1,
    official_valid_rate: 0.5,
    coverage: 0.5,
    raw_rate: 0.25,
    ...over,
  })

  const totals = (over: Record<string, unknown> = {}) => ({
    ...languageRow(over),
    by_language: { python: languageRow(over) },
    by_reason: { official_resolved: 1, test_failed: 1, golden_apply_failed: 1 },
  })

  const section = (over: Record<string, unknown> = {}) => ({
    schema_version: 1,
    totals: totals(),
    evaluator: { id: "swe-bench-promax" },
    instances: [{ instance_id: "i-1" }, { instance_id: "i-2" }, { instance_id: "i-3" }],
    missing_instance_ids: ["i-4"],
    ...over,
  })

  test("PAIRED CONTROL: a consistent section decodes", () => {
    const decoded = decodeOfficialGradeSection(section())
    expect(decoded.totals.assigned).toBe(4)
    expect(decoded.missing_instance_ids).toEqual(["i-4"])
    expect(decoded.instances).toHaveLength(3)
  })

  test("`missing_instance_ids` shorter than `totals.missing` is REFUSED", () => {
    // The flattering edit: drop the ids so nobody can see which rows are gone,
    // while the totals still (correctly) say one is.
    expect(() => decodeOfficialGradeSection(section({ missing_instance_ids: [] }))).toThrow(
      /missing/,
    )
  })

  test("`missing_instance_ids` longer than `totals.missing` is REFUSED", () => {
    expect(() =>
      decodeOfficialGradeSection(section({ missing_instance_ids: ["i-4", "i-5"] })),
    ).toThrow(/missing/)
  })

  test("an `instances` array that does not cover `attempted` is REFUSED", () => {
    expect(() =>
      decodeOfficialGradeSection(section({ instances: [{ instance_id: "i-1" }] })),
    ).toThrow(/instances|attempted/)
  })

  test("a missing id that ALSO appears among the graded instances is REFUSED", () => {
    expect(() =>
      decodeOfficialGradeSection(
        section({
          instances: [{ instance_id: "i-1" }, { instance_id: "i-2" }, { instance_id: "i-4" }],
          missing_instance_ids: ["i-4"],
        }),
      ),
    ).toThrow(/i-4/)
  })

  test("a duplicated missing id is REFUSED (it would pad the count)", () => {
    expect(() =>
      decodeOfficialGradeSection(
        section({
          totals: totals({ assigned: 5, missing: 2, coverage: 0.4, raw_rate: 0.2 }),
          // Two "missing" rows, ONE real instance — the count agrees while the
          // campaign has quietly lost a name.
          missing_instance_ids: ["i-4", "i-4"],
        }),
      ),
    ).toThrow(/i-4/)
  })

  test("the by_reason table must count exactly the graded instances", () => {
    // Non-vacuity floor for the pre-existing partition checks: they are still
    // live, so the new cross-checks are additive rather than a replacement.
    expect(() =>
      decodeOfficialGradeSection(section({ totals: { ...totals(), by_reason: {} } })),
    ).toThrow(/by_reason/)
  })
})

// ---------------------------------------------------------------------------
// C5 — a chunk merge keeps the chunk's denominator and its failure codes
// ---------------------------------------------------------------------------

describe("C5 — chunk-level merge preserves denominator and refusal reason", () => {
  const CHUNK: PoolChunk = {
    runId: "chunk-a",
    datasetPath: "/tmp/chunk-a.jsonl",
    instanceIds: ["i-1", "i-2", "i-3"],
  }

  test("the merged chunk receipt keeps the chunk's DECLARED instance set", () => {
    const acc = createChunkCoverageAccumulator()
    // The box graded 2 of 3 and died; only those two came back.
    accumulateChunkCoverage(acc, {
      officialGrade: receiptOf(["i-1", "i-2"], [dispo("i-1"), dispo("i-2")]),
    })
    const result = chunkCoverageResult(acc, CHUNK)
    if (result.officialGrade === undefined) throw new Error("expected a merged receipt")
    // The denominator is the CHUNK's, not "whatever came back".
    expect([...result.officialGrade.assignedInstanceIds]).toEqual(["i-1", "i-2", "i-3"])
    expect(deriveMissingInstanceIds(result.officialGrade)).toEqual(["i-3"])
  })

  test("a REFUSED chunk merge preserves the typed failure code", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, {
      officialGrade: receiptOf(["i-1"], [dispo("i-1")]),
    })
    accumulateChunkCoverage(acc, {
      // A second evaluator build for the same chunk — the fault a dead box and a
      // two-grader campaign used to be byte-indistinguishable in.
      officialGrade: receiptOf(
        ["i-2"],
        [dispo("i-2")],
        evaluatorMeta({ evaluatorId: "swe-bench-promax-patched" }),
      ),
    })
    const result = chunkCoverageResult(acc, CHUNK)
    expect(result.officialGrade).toBeUndefined()
    expect(result.officialGradeFailures?.map((f) => f.code)).toEqual(["evaluator_meta_invalid"])
    expect(result.officialGradeFailures?.[0]?.message).toContain("swe-bench-promax-patched")
  })

  test("a duplicate disposition across two pieces is ALSO reported, not silently dropped", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, { officialGrade: receiptOf(["i-1"], [dispo("i-1")]) })
    accumulateChunkCoverage(acc, {
      officialGrade: receiptOf(["i-1"], [dispo("i-1", "model_miss")]),
    })
    const result = chunkCoverageResult(acc, CHUNK)
    expect(result.officialGrade).toBeUndefined()
    expect(result.officialGradeFailures?.map((f) => f.code)).toEqual(["disposition_duplicated"])
  })

  test("PAIRED CONTROL: a chunk with no receipts carries neither field", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, { resolved: ["i-1"] })
    const result = chunkCoverageResult(acc, CHUNK)
    expect(result.officialGrade).toBeUndefined()
    expect(result.officialGradeFailures).toBeUndefined()
    expect(result.resolved).toEqual(["i-1"])
  })
})
