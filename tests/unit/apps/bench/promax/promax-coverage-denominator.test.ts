/**
 * aug-22 coverage/denominator audit — C-A and C-B.
 *
 * Both defects are the SAME shape as the ones PMX-03/04 already closed, one
 * layer out: a guard that exists, and a DEFAULT path that never reaches it.
 *
 *   C-A  `mergedChunkReceipt` unions the chunk's declared instance set into the
 *        merged receipt's denominator — but only `...(chunk.instanceIds !==
 *        undefined ? …)`, and the DEFAULT pool chunk builder (no `--chunk-size`)
 *        never set that field. So on the default path a chunk whose box died
 *        after grading 2 of N merged to a receipt claiming N=2 assigned.
 *
 *   C-B  the persisted section's read boundary validates the section against
 *        ITSELF. A hand edit that drops the missing ids, zeroes `totals.missing`
 *        and decrements `assigned` is internally consistent at every one of
 *        those checks — coverage does not fall, it reads 100%. Nothing tied the
 *        section's roster to the campaign it belongs to.
 *
 * Everything below drives the DEFAULT production entry point: `resolvePoolChunks`
 * as `cmdPool` calls it (argv carries no `--chunk-size`), and
 * `decodeCanonicalReport`, the single read-normalization boundary every consumer
 * of a persisted report enters through.
 *
 * ⚠️ SPEND SAFETY. Pure functions, temp files, and the real family reader only —
 * no ssh, no Docker, no EC2, nothing that provisions or bills.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePoolChunks } from "@/apps/bench/commands/pool"
import {
  accumulateChunkCoverage,
  chunkCoverageResult,
  createChunkCoverageAccumulator,
  missingInstances,
} from "@/apps/bench/remote/pool/coverage"
import type { PoolChunk } from "@/apps/bench/remote/pool/types"
import {
  buildOfficialGradeReceipt,
  type OfficialGradeDisposition,
  type OfficialGradeReceipt,
} from "@/runner/batch/eval/official-grade"
import { decodeCanonicalReport } from "@/runner/batch/report-envelope"
import {
  aggregateOfficialGrade,
  type OfficialGradeSection,
} from "@/runner/batch/report-official-grade"
import { evaluatorMeta, OUTPUT_PATH, oracleSha256 } from "./promax-official-fixtures"

const artifact = { path: OUTPUT_PATH, sha256: oracleSha256("doc"), byteLength: 3 }

const dispo = (id: string, state: "resolved" | "model_miss" = "resolved") =>
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
): OfficialGradeReceipt => {
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    dispositions,
    evaluator: evaluatorMeta(),
  })
  if (!built.ok) throw new Error(`fixture receipt refused: ${JSON.stringify(built.failures)}`)
  return built.receipt
}

// ---------------------------------------------------------------------------
// C-A — the DEFAULT pool chunk builder must declare the chunk's assigned set
// ---------------------------------------------------------------------------

/** A real dataset file, read back by the REAL family reader — never a chunk
 *  object with the field hand-set (that is precisely the defect: proving the
 *  merge on a constructed chunk proved nothing about production). */
const datasetWith = (ids: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "pool-default-chunk-"))
  const path = join(dir, "wave.jsonl")
  writeFileSync(
    path,
    `${ids
      .map((id) =>
        JSON.stringify({
          instance_id: id,
          repo: "acme/widget",
          base_commit: "0".repeat(40),
          problem_statement: `fix ${id}`,
          FAIL_TO_PASS: '["t"]',
          PASS_TO_PASS: "[]",
        }),
      )
      .join("\n")}\n`,
  )
  return path
}

/** The chunk `cmdPool` builds by DEFAULT: no `--chunk-size` on argv, so
 *  `resolvePoolChunks` takes the whole-dataset branch. */
const defaultChunkFor = (ids: readonly string[]): PoolChunk => {
  expect(process.argv).not.toContain("--chunk-size")
  const chunks = resolvePoolChunks([datasetWith(ids)], false, "verified")
  const chunk = chunks[0]
  if (chunk === undefined) throw new Error("the default builder produced no chunk")
  return chunk
}

describe("C-A — the default chunk builder declares what the chunk is accountable for", () => {
  const IDS = ["acme__widget-1", "acme__widget-2", "acme__widget-3"]

  test("a DEFAULT whole-dataset chunk carries every instance id in the dataset", () => {
    const chunk = defaultChunkFor(IDS)
    expect(chunk.instanceIds).toEqual(IDS)
    // Non-vacuity: the runId still comes off the dataset basename, so this is the
    // same chunk the pool has always built, only no longer denominator-blind.
    expect(chunk.runId).toBe("wave")
  })

  test("a box that died after grading 2 of 3 keeps a denominator of 3", () => {
    const chunk = defaultChunkFor(IDS)
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, {
      officialGrade: receiptOf(IDS.slice(0, 2), [dispo(IDS[0]!), dispo(IDS[1]!, "model_miss")]),
      resolved: [IDS[0]!],
    })
    const result = chunkCoverageResult(acc, chunk)
    // THE defect: without the declared set this merged to assigned=2 — a 100%
    // coverage claim over the two rows that happened to come back.
    expect([...(result.officialGrade?.assignedInstanceIds ?? [])].sort()).toEqual([...IDS].sort())
    expect(missingInstances(result, chunk)).toEqual([IDS[2]!])
  })

  test("PAIRED CONTROL — a chunk that graded everything is still complete", () => {
    const chunk = defaultChunkFor(IDS)
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, {
      officialGrade: receiptOf(IDS, IDS.map((id) => dispo(id))),
      resolved: [...IDS],
    })
    const result = chunkCoverageResult(acc, chunk)
    expect(result.officialGrade?.assignedInstanceIds).toHaveLength(3)
    expect(missingInstances(result, chunk)).toEqual([])
  })

  test("an unreadable dataset REFUSES rather than planning a denominator-less chunk", () => {
    expect(() => resolvePoolChunks([join(tmpdir(), "definitely-absent.jsonl")], false, "verified"))
      .toThrow(/could not be read|no parseable task rows/)
  })
})

// ---------------------------------------------------------------------------
// C-B — a persisted section may not delete its own missing rows
// ---------------------------------------------------------------------------

const sectionFor = (assigned: readonly string[], graded: readonly string[]): OfficialGradeSection =>
  aggregateOfficialGrade({
    receipt: receiptOf(assigned, graded.map((id) => dispo(id))),
    campaign: {
      quantaSha: "a".repeat(40),
      quantaDirty: false,
      provider: "openai-responses",
      model: "gpt-5.4",
    },
  })

/** A SWE report as it is PERSISTED: the run's own per-instance rows plus the
 *  official section. This is what `decodeCanonicalReport` reads off disk. */
const reportDoc = (section: unknown, attempted: readonly string[]): Record<string, unknown> => ({
  timestamp: "2026-08-22T00:00:00.000Z",
  model: "gpt-5.4",
  provider: "openai-responses",
  n: attempted.length,
  totals: { total: attempted.length, resolved: 1, resolvedPct: 25 },
  perInstance: attempted.map((id) => ({ id, passed: false, turns: 3, patchBytes: 10 })),
  officialGrade: section,
})

/** The flattering hand edit: delete the named gap, zero `missing`, and shrink
 *  `assigned` to match. Every pre-existing check stays satisfied. */
const deleteMissingRows = (section: OfficialGradeSection): Record<string, unknown> => {
  const raw = JSON.parse(JSON.stringify(section)) as Record<string, unknown>
  const shrink = (t: Record<string, unknown>): Record<string, unknown> => {
    const assigned = (t.assigned as number) - (t.missing as number)
    const gradingValid = t.grading_valid as number
    const resolved = t.resolved as number
    return {
      ...t,
      assigned,
      missing: 0,
      coverage: assigned === 0 ? null : gradingValid / assigned,
      raw_rate: assigned === 0 ? null : resolved / assigned,
    }
  }
  const totals = shrink(raw.totals as Record<string, unknown>)
  totals.by_language = Object.fromEntries(
    Object.entries((raw.totals as Record<string, unknown>).by_language as Record<string, unknown>)
      .map(([k, v]) => [k, shrink(v as Record<string, unknown>)]),
  )
  raw.totals = totals
  raw.missing_instance_ids = []
  return raw
}

describe("C-B — a hand-edited section cannot delete the rows it lost", () => {
  const ASSIGNED = ["i-1", "i-2", "i-3", "i-4"]
  const GRADED = ["i-1", "i-2", "i-3"]

  test("PAIRED CONTROL: the honest section decodes and still names its gap", () => {
    const decoded = decodeCanonicalReport(
      JSON.parse(JSON.stringify(reportDoc(sectionFor(ASSIGNED, GRADED), ASSIGNED))),
    )
    if (decoded.benchmarkSuite !== "swe-bench") throw new Error("expected a swe report")
    expect(decoded.officialGrade?.totals.assigned).toBe(4)
    expect(decoded.officialGrade?.missing_instance_ids).toEqual(["i-4"])
    expect(decoded.officialGrade?.totals.coverage).toBe(0.75)
  })

  test("the edit is INTERNALLY CONSISTENT — it survives every self-check", () => {
    // Non-vacuity for the refusal below: the attack is not caught by the
    // partition arithmetic or by the row/total cross-checks. It reads 100%.
    const edited = deleteMissingRows(sectionFor(ASSIGNED, GRADED))
    const totals = edited.totals as Record<string, unknown>
    expect(totals.assigned).toBe(3)
    expect(totals.missing).toBe(0)
    expect(totals.coverage).toBe(1)
  })

  test("the shrunken section is REFUSED at the report read boundary", () => {
    const doc = reportDoc(deleteMissingRows(sectionFor(ASSIGNED, GRADED)), ASSIGNED)
    expect(() => decodeCanonicalReport(JSON.parse(JSON.stringify(doc)))).toThrow(/i-4/)
  })

  test("a section that names a DUPLICATE graded row is REFUSED", () => {
    const raw = JSON.parse(JSON.stringify(sectionFor(ASSIGNED, GRADED))) as Record<string, unknown>
    const rows = raw.instances as Record<string, unknown>[]
    rows[2] = { ...rows[0]! }
    expect(() => decodeCanonicalReport(reportDoc(raw, ASSIGNED))).toThrow(/i-1/)
  })

  test("a report carrying a section but NO per-instance rows is REFUSED", () => {
    const doc = reportDoc(sectionFor(ASSIGNED, GRADED), ASSIGNED)
    delete doc.perInstance
    expect(() => decodeCanonicalReport(doc)).toThrow(/perInstance/)
  })
})
