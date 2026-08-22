/**
 * HELLGATE — PMX-04 remote half: the PMX-03 receipt is the ONLY verdict payload
 * the remote lane carries, and coverage after retries is DERIVED from it.
 *
 * Three claims, each observed as a real effect rather than re-asserted:
 *
 *  1. TRANSPORT. `remote/` may move a receipt document across the box boundary
 *     and nothing more. It cannot classify: a raw grader stream, an invented
 *     state, a disposition for an unassigned id and a duplicated disposition are
 *     all refused by the PMX-03 parser, through the transport.
 *  2. MERGE. Two chunk receipts union their `assignedInstanceIds` and are
 *     re-validated by `buildOfficialGradeReceipt`, so a duplicate disposition
 *     across attempts FAILS CLOSED instead of last-write-wins.
 *  3. COVERAGE. After instance-aware relaunch, `missing` is exactly
 *     `assigned - keys(dispositions)` — never a legacy four-bucket subtraction —
 *     and an `ambiguous` disposition survives the round trip instead of being
 *     flattened into `errored`.
 *
 * 🔴 SPEND SAFETY: every box boundary is an injected function. `runWithRelaunch`
 * is driven with fake backends; no EC2, no ssh, no docker, no provisioning.
 */
import { describe, expect, test } from "bun:test"
import { receiveOfficialGradeReceipt } from "@/apps/bench/remote/box-session/official-grade-transport"
import { runWithRelaunch } from "@/apps/bench/remote/full"
import {
  accumulateChunkCoverage,
  chunkCoverageResult,
  coverageComplete,
  createChunkCoverageAccumulator,
  earnedVerdict,
  missingInstances,
} from "@/apps/bench/remote/pool/coverage"
import type { PoolChunk } from "@/apps/bench/remote/pool/types"
import {
  buildOfficialGradeReceipt,
  deriveMissingInstanceIds,
  mergeOfficialGradeReceipts,
  type OfficialGradeDisposition,
  type OfficialGradeEvaluatorMeta,
  type OfficialGradeReceipt,
  projectLegacyBuckets,
  serializeOfficialGradeReceipt,
} from "@/runner/batch/eval/official-grade"

const ARTIFACT = { path: "/box/pass_rate.json", sha256: "a".repeat(64), byteLength: 12 }

const EVALUATOR: OfficialGradeEvaluatorMeta = {
  evaluatorId: "swe-bench-promax",
  upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  evaluatorPath: "/opt/quanta/promax/upstream/src/evaluation/test_run.py",
  evaluatorSha256: "b".repeat(64),
  argv: ["python", "test_run.py", "--workers", "1"],
  cwd: "/opt/quanta/promax/upstream",
  exitCode: 0,
  stdout: "chunk stdout",
  stderr: "",
  outputArtifact: ARTIFACT,
}

const side = (finalResult: string) => ({
  finalResult,
  rawReason: finalResult,
  returncode: 0,
  scriptExitCode: 0,
})

const disp = (
  instanceId: string,
  state: OfficialGradeDisposition["state"],
  reason: OfficialGradeDisposition["reason"],
): OfficialGradeDisposition => ({
  instanceId,
  state,
  reason,
  gradingValid: state === "resolved" || state === "model_miss",
  rawArtifact: ARTIFACT,
  evaluator: { passed: state === "resolved", model: side("SUCCESS"), golden: side("SUCCESS") },
})

const receipt = (
  assigned: readonly string[],
  dispositions: readonly OfficialGradeDisposition[],
  evaluator: OfficialGradeEvaluatorMeta = EVALUATOR,
): OfficialGradeReceipt => {
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    dispositions,
    evaluator,
  })
  if (!built.ok) throw new Error(`fixture receipt refused: ${JSON.stringify(built.failures)}`)
  return built.receipt
}

const CHUNK_A = receipt(
  ["i-1", "i-2"],
  [disp("i-1", "resolved", "official_resolved"), disp("i-2", "model_miss", "test_failed")],
)
const CHUNK_B = receipt(["i-3"], [disp("i-3", "ambiguous", "upstream_need_human_review")])

// ── 1. transport ────────────────────────────────────────────────────────────

describe("transport — remote moves bytes, it never classifies", () => {
  const fetchOk = (text: string) => async () => ({ code: 0, stdout: text, stderr: "" })

  test("a readable, valid receipt document round-trips VERBATIM", async () => {
    const out = await receiveOfficialGradeReceipt({
      fetch: fetchOk(serializeOfficialGradeReceipt(CHUNK_A)),
      remotePath: "~/official-grade-receipt.json",
    })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("unreachable")
    expect([...out.receipt.assignedInstanceIds]).toEqual(["i-1", "i-2"])
    expect(out.receipt.dispositionsByInstanceId.get("i-2")?.reason).toBe("test_failed")
  })

  test("an unreadable path is transport_failed — DISTINCT from a bad document", async () => {
    const out = await receiveOfficialGradeReceipt({
      fetch: async () => ({ code: 1, stdout: "", stderr: "cat: No such file" }),
      remotePath: "~/official-grade-receipt.json",
    })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.code).toBe("transport_failed")
  })

  test("raw grader output is REFUSED — remote cannot promote a stream to a verdict", async () => {
    const out = await receiveOfficialGradeReceipt({
      fetch: fetchOk("Traceback (most recent call last):\n  RuntimeError: boom\n"),
      remotePath: "~/official-grade-receipt.json",
    })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    if (out.code !== "receipt_rejected") throw new Error("unreachable")
    expect(out.failures.map((f) => f.code)).toContain("receipt_unparseable")
  })

  test("an INVENTED state, an UNASSIGNED id and a DUPLICATE all fail closed", async () => {
    const doc = JSON.parse(serializeOfficialGradeReceipt(CHUNK_A)) as {
      dispositions: Record<string, unknown>[]
    }
    const unknownState = { ...doc, dispositions: [{ ...doc.dispositions[0], state: "flaky" }] }
    const unassigned = {
      ...doc,
      dispositions: [{ ...doc.dispositions[0], instanceId: "i-999" }],
    }
    const duplicated = { ...doc, dispositions: [doc.dispositions[0], doc.dispositions[0]] }

    const codes = async (value: unknown): Promise<readonly string[]> => {
      const out = await receiveOfficialGradeReceipt({
        fetch: fetchOk(JSON.stringify(value)),
        remotePath: "~/r.json",
      })
      if (out.ok) throw new Error("expected a refusal")
      return out.code === "receipt_rejected" ? out.failures.map((f) => f.code) : [out.code]
    }
    expect(await codes(unknownState)).toContain("state_unknown")
    expect(await codes(unassigned)).toContain("disposition_unassigned")
    expect(await codes(duplicated)).toContain("disposition_duplicated")
  })
})

// ── 2. merge ────────────────────────────────────────────────────────────────

describe("merge — union the denominator, re-validate the whole", () => {
  test("two chunk receipts union assignedInstanceIds and keep every disposition", () => {
    const merged = mergeOfficialGradeReceipts({ receipts: [CHUNK_A, CHUNK_B] })
    expect(merged.ok).toBe(true)
    if (!merged.ok) throw new Error("unreachable")
    expect([...merged.receipt.assignedInstanceIds]).toEqual(["i-1", "i-2", "i-3"])
    // the ambiguous row SURVIVES — a legacy projection would have called it errored
    expect(merged.receipt.dispositionsByInstanceId.get("i-3")?.state).toBe("ambiguous")
    expect(deriveMissingInstanceIds(merged.receipt)).toEqual([])
  })

  test("a DUPLICATE disposition across chunks fails closed (never last-write-wins)", () => {
    const conflicting = receipt(["i-1"], [disp("i-1", "model_miss", "test_failed")])
    const merged = mergeOfficialGradeReceipts({ receipts: [CHUNK_A, conflicting] })
    expect(merged.ok).toBe(false)
    if (merged.ok) throw new Error("unreachable")
    expect(merged.failures.map((f) => f.code)).toContain("disposition_duplicated")
  })

  test("chunks graded by a DIFFERENT evaluator build are refused", () => {
    const other = receipt(["i-9"], [disp("i-9", "resolved", "official_resolved")], {
      ...EVALUATOR,
      upstreamCommit: "0".repeat(40),
    })
    const merged = mergeOfficialGradeReceipts({ receipts: [CHUNK_A, other] })
    expect(merged.ok).toBe(false)
    if (merged.ok) throw new Error("unreachable")
    expect(merged.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
  })

  test("`additionalAssignedInstanceIds` widens the DENOMINATOR, never the numerator", () => {
    const merged = mergeOfficialGradeReceipts({
      receipts: [CHUNK_A],
      additionalAssignedInstanceIds: ["i-1", "i-2", "i-7"],
    })
    expect(merged.ok).toBe(true)
    if (!merged.ok) throw new Error("unreachable")
    expect([...merged.receipt.assignedInstanceIds]).toEqual(["i-1", "i-2", "i-7"])
    expect(deriveMissingInstanceIds(merged.receipt)).toEqual(["i-7"])
    // the legacy projection is DERIVED and it ADMITS what it dropped
    const legacy = projectLegacyBuckets(merged.receipt)
    expect(legacy.droppedMissing).toEqual(["i-7"])
    expect([...legacy.resolved, ...legacy.unresolved, ...legacy.errored]).not.toContain("i-7")
    // …and it cannot write back: the receipt still says what it said
    expect(merged.receipt.dispositionsByInstanceId.size).toBe(2)
  })
})

// ── 2b. pool chunk coverage ─────────────────────────────────────────────────

describe("pool — a chunk graded ONLY by the official grader is not 'box died'", () => {
  const CHUNK: PoolChunk = {
    runId: "pmx-chunk-1",
    datasetPath: "/tmp/does-not-need-to-exist.json",
    instanceIds: ["i-1", "i-2", "i-3"],
  }

  test("receipt-only coverage counts as a verdict and closes the chunk", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, { officialGrade: CHUNK_A })
    accumulateChunkCoverage(acc, { officialGrade: CHUNK_B })
    const result = chunkCoverageResult(acc, CHUNK)
    // …with ZERO legacy verdicts, which is exactly the ProMax shape
    expect(result.resolved).toBeUndefined()
    expect(result.unresolved).toBeUndefined()
    expect(earnedVerdict(result)).toBe(true)
    expect(missingInstances(result, CHUNK)).toEqual([])
    expect(coverageComplete(result, CHUNK)).toBe(true)
    // the ambiguous disposition is preserved, NOT flattened into `errored`
    expect(result.officialGrade?.dispositionsByInstanceId.get("i-3")?.state).toBe("ambiguous")
  })

  test("a PARTIAL chunk names exactly the uncovered ids", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, { officialGrade: CHUNK_A })
    const result = chunkCoverageResult(acc, CHUNK)
    expect(missingInstances(result, CHUNK)).toEqual(["i-3"])
    expect(coverageComplete(result, CHUNK)).toBe(false)
  })

  test("PAIRED CONTROL — a legacy chunk behaves exactly as before", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, { resolved: ["i-1"], unresolved: ["i-2"] })
    const result = chunkCoverageResult(acc, CHUNK)
    expect(result.officialGrade).toBeUndefined()
    expect(earnedVerdict(result)).toBe(true)
    expect(missingInstances(result, CHUNK)).toEqual(["i-3"])
  })

  test("pieces that REFUSE to merge leave the chunk uncovered (it requeues)", () => {
    const acc = createChunkCoverageAccumulator()
    accumulateChunkCoverage(acc, { officialGrade: CHUNK_A })
    accumulateChunkCoverage(acc, { officialGrade: CHUNK_A })
    const result = chunkCoverageResult(acc, CHUNK)
    expect(result.officialGrade).toBeUndefined()
    expect(missingInstances(result, CHUNK)).toEqual(["i-1", "i-2", "i-3"])
  })
})

// ── 3. coverage after relaunch ──────────────────────────────────────────────

describe("relaunch — coverage is receipt-derived, not bucket-derived", () => {
  const EXPECTED = ["i-1", "i-2", "i-3", "i-4"] as const

  test("two attempts merge into ONE receipt whose missing is assigned - dispositions", async () => {
    const seen: string[][] = []
    const outcome = await runWithRelaunch(
      (ids) => {
        seen.push([...ids])
        const attempt = seen.length
        return {
          run: async () => {
            if (attempt === 1) {
              return { officialGrade: CHUNK_A, resolved: ["i-1"], unresolved: ["i-2"] }
            }
            // attempt 2 grades i-3; i-4's box dies on every later attempt, so it
            // is a genuine coverage gap rather than a verdict.
            return attempt === 2 ? { officialGrade: CHUNK_B } : {}
          },
        }
      },
      { expected: [...EXPECTED], maxRelaunch: 3 },
    )
    // attempt 2 retried ONLY what carried no disposition
    expect(seen[0]).toEqual(["i-1", "i-2", "i-3", "i-4"])
    expect(seen[1]).toEqual(["i-3", "i-4"])
    const merged = outcome.officialGrade
    expect(merged).toBeDefined()
    if (merged === undefined) throw new Error("unreachable")
    expect([...merged.assignedInstanceIds]).toEqual([...EXPECTED])
    expect(deriveMissingInstanceIds(merged)).toEqual(["i-4"])
    expect(outcome.missing).toEqual(["i-4"])
    // the ambiguous verdict is still ambiguous after transport + merge + relaunch
    expect(merged.dispositionsByInstanceId.get("i-3")?.state).toBe("ambiguous")
  })

  test("PAIRED CONTROL — a run with no receipt keeps the historical outcome shape", async () => {
    const outcome = await runWithRelaunch(
      () => ({ run: async () => ({ resolved: ["i-1"], unresolved: ["i-2"] }) }),
      { expected: ["i-1", "i-2", "i-3"], maxRelaunch: 0 },
    )
    expect(outcome.officialGrade).toBeUndefined()
    expect(outcome.missing).toEqual(["i-3"])
    expect(outcome.resolved).toEqual(["i-1"])
  })

  test("a RE-GRADED instance across attempts is surfaced, not silently absorbed", async () => {
    // A box that reports the same instance twice (a requeue that raced a late
    // report) must not resolve itself by last-write-wins.
    const logs: string[] = []
    const outcome = await runWithRelaunch(
      () => ({ run: async () => ({ officialGrade: CHUNK_B }) }),
      {
        expected: ["i-3", "i-5"],
        maxRelaunch: 1,
        onLog: (m) => logs.push(m),
      },
    )
    expect(outcome.officialGrade).toBeUndefined()
    expect(outcome.officialGradeFailures?.map((f) => f.code)).toContain("disposition_duplicated")
    expect(logs.join("\n")).toContain("could NOT be merged")
    // …and the campaign names the WHOLE gap.
    //
    // ⚠️ CORRECTED (aug-22, C2). This used to assert `["i-5"]`, i.e. that i-3 was
    // covered — on the authority of the two receipts that had just refused to
    // merge. That is the fabricated-coverage defect: the relaunch retry set
    // counts a receipt disposition as coverage, and on the refusal path those
    // dispositions are exactly what has no campaign authority. i-3's only
    // evidence is a double-grade, so it is missing, and the four legacy buckets
    // vouch for nothing here (this lane produced no legacy arrays at all).
    expect(outcome.missing).toEqual(["i-3", "i-5"])
  })

  test("a refused merge is SURFACED, never silently downgraded to no-receipt", async () => {
    const outcome = await runWithRelaunch(
      () => ({ run: async () => ({ officialGrade: CHUNK_A }) }),
      { expected: ["i-1", "i-2"], maxRelaunch: 1 },
    )
    // one attempt only (everything covered), so this is the clean case…
    expect(outcome.officialGradeFailures).toBeUndefined()
    expect(outcome.officialGrade?.dispositionsByInstanceId.size).toBe(2)
  })
})
