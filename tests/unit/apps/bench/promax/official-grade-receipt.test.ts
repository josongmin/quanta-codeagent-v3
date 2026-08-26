/**
 * PMX-03 — the app-independent official-grade receipt (`src/runner/batch/eval/
 * official-grade`). Nothing here imports an `apps/bench` type: that import
 * boundary IS the contract, and a runner-side type that needed ProMax would
 * fail to compile.
 *
 * The invariant this file exists to pin: `missing` is NEVER a value anybody
 * emits — it is derived EXACTLY as `assigned - keys(dispositions)`.
 */
import { describe, expect, test } from "bun:test"
import type {
  OfficialGradeDisposition,
  OfficialGradeReceipt,
  OfficialGradeReceiptResult,
  OfficialGradeState,
} from "@/runner/batch/eval/official-grade"
import {
  buildOfficialGradeReceipt,
  deriveMissingInstanceIds,
  LEGACY_BUCKET_BY_STATE,
  parseOfficialGradeReceipt,
  projectLegacyBuckets,
  serializeOfficialGradeReceipt,
  summarizeOfficialGrade,
} from "@/runner/batch/eval/official-grade"
import { evaluatorMeta, OUTPUT_PATH, oracleSha256 } from "./promax-official-fixtures"

const artifact = { path: OUTPUT_PATH, sha256: oracleSha256("doc"), byteLength: 3 }

interface DispoSpec {
  readonly id: string
  readonly state: OfficialGradeState
  readonly reason: string
  readonly gradingValid?: boolean
  readonly predictionEmpty?: boolean
  readonly nullArtifact?: boolean
}

const dispo = (s: DispoSpec): OfficialGradeDisposition =>
  ({
    instanceId: s.id,
    state: s.state,
    reason: s.reason,
    gradingValid: s.gradingValid ?? (s.state === "resolved" || s.state === "model_miss"),
    rawArtifact: s.nullArtifact === true ? null : artifact,
    evaluator: { passed: null, model: null, golden: null },
    ...(s.predictionEmpty === undefined ? {} : { predictionEmpty: s.predictionEmpty }),
  }) as OfficialGradeDisposition

const build = (
  assigned: readonly string[],
  dispositions: readonly OfficialGradeDisposition[],
): OfficialGradeReceiptResult =>
  buildOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    dispositions,
    evaluator: evaluatorMeta(),
  })

const okReceipt = (r: OfficialGradeReceiptResult): OfficialGradeReceipt => {
  if (!r.ok) throw new Error(`expected ok receipt, got: ${r.failures.map((f) => f.code).join(",")}`)
  return r.receipt
}

const codesOf = (r: OfficialGradeReceiptResult): readonly string[] =>
  r.ok ? [] : r.failures.map((f) => f.code)

const HAPPY = {
  assigned: ["i-1", "i-2", "i-3", "i-4", "i-5", "i-6"],
  dispositions: [
    dispo({ id: "i-1", state: "resolved", reason: "official_resolved" }),
    dispo({ id: "i-2", state: "model_miss", reason: "test_failed" }),
    dispo({ id: "i-3", state: "model_miss", reason: "patch_apply_failed", predictionEmpty: true }),
    dispo({ id: "i-4", state: "infra_invalid", reason: "golden_apply_failed" }),
    dispo({ id: "i-5", state: "ambiguous", reason: "upstream_need_human_review" }),
    // i-6 has NO disposition ⇒ it must surface as `missing` by derivation only
  ],
} as const

describe("official-grade receipt — missing is derived, never emitted", () => {
  test("missing = assigned - keys(dispositions), exactly", () => {
    const receipt = okReceipt(build(HAPPY.assigned, HAPPY.dispositions))
    expect(deriveMissingInstanceIds(receipt)).toEqual(["i-6"])
  })

  test("no disposition may carry a `missing` state (it is not in the union)", () => {
    const forged = {
      ...dispo({ id: "i-6", state: "resolved", reason: "official_resolved" }),
      state: "missing",
    }
    expect(codesOf(build(HAPPY.assigned, [forged as OfficialGradeDisposition]))).toContain(
      "state_unknown",
    )
  })

  test("full coverage ⇒ zero missing; adding an assigned id creates one", () => {
    const covered = okReceipt(build(["i-1", "i-2"], HAPPY.dispositions.slice(0, 2)))
    expect(deriveMissingInstanceIds(covered)).toEqual([])
    const widened = okReceipt(build(["i-1", "i-2", "i-9"], HAPPY.dispositions.slice(0, 2)))
    expect(deriveMissingInstanceIds(widened)).toEqual(["i-9"])
  })
})

describe("official-grade receipt — fail-closed construction", () => {
  test("duplicate dispositions for one instance fail closed", () => {
    const r = build(HAPPY.assigned, [
      ...HAPPY.dispositions,
      dispo({ id: "i-1", state: "model_miss", reason: "test_failed" }),
    ])
    expect(codesOf(r)).toContain("disposition_duplicated")
    expect(r.ok).toBe(false)
  })

  test("a disposition for an UNASSIGNED instance fails closed", () => {
    const r = build(HAPPY.assigned, [
      ...HAPPY.dispositions,
      dispo({ id: "not-assigned", state: "resolved", reason: "official_resolved" }),
    ])
    expect(codesOf(r)).toContain("disposition_unassigned")
    expect(r.ok).toBe(false)
  })

  test("an unknown state fails closed", () => {
    const forged = {
      ...dispo({ id: "i-2", state: "resolved", reason: "official_resolved" }),
      state: "flaky",
    }
    expect(codesOf(build(HAPPY.assigned, [forged as OfficialGradeDisposition]))).toContain(
      "state_unknown",
    )
  })

  test("an unknown reason fails closed", () => {
    const forged = dispo({ id: "i-2", state: "model_miss", reason: "vibes" })
    expect(codesOf(build(HAPPY.assigned, [forged]))).toContain("reason_unknown")
  })

  test("a known reason under the WRONG state fails closed", () => {
    const forged = dispo({
      id: "i-2",
      state: "resolved",
      reason: "golden_apply_failed",
      gradingValid: true,
    })
    expect(codesOf(build(HAPPY.assigned, [forged]))).toContain("state_reason_mismatch")
  })

  test("a lied-about grading_valid fails closed (it is derived, not declared)", () => {
    const lied = dispo({
      id: "i-4",
      state: "infra_invalid",
      reason: "golden_apply_failed",
      gradingValid: true,
    })
    expect(codesOf(build(HAPPY.assigned, [lied]))).toContain("grading_valid_mismatch")
  })

  test("a null raw artifact is legal ONLY for infra_invalid", () => {
    const infra = dispo({
      id: "i-4",
      state: "infra_invalid",
      reason: "evaluator_no_output",
      nullArtifact: true,
    })
    expect(build(HAPPY.assigned, [infra]).ok).toBe(true)

    const resolvedNoArtifact = dispo({
      id: "i-1",
      state: "resolved",
      reason: "official_resolved",
      nullArtifact: true,
    })
    expect(codesOf(build(HAPPY.assigned, [resolvedNoArtifact]))).toContain("raw_artifact_missing")
  })

  test("blank or duplicated assigned ids fail closed", () => {
    expect(codesOf(build(["i-1", ""], []))).toContain("assigned_id_invalid")
    expect(codesOf(build(["i-1", "i-1"], []))).toContain("assigned_id_duplicated")
  })

  test("failures ACCUMULATE — one defect never masks another's code", () => {
    const r = build(HAPPY.assigned, [
      dispo({ id: "i-2", state: "model_miss", reason: "vibes" }),
      dispo({ id: "elsewhere", state: "resolved", reason: "official_resolved" }),
    ])
    expect([...codesOf(r)].sort()).toEqual(["disposition_unassigned", "reason_unknown"])
  })
})

describe("official-grade receipt — score contract", () => {
  test("assigned = resolved + model_miss + infra_invalid + ambiguous + missing", () => {
    const s = summarizeOfficialGrade(okReceipt(build(HAPPY.assigned, HAPPY.dispositions)))
    expect(s).toEqual({
      assigned: 6,
      resolved: 1,
      modelMiss: 2,
      infraInvalid: 1,
      ambiguous: 1,
      missing: 1,
      gradingValid: 3,
      officialValidRate: 1 / 3,
      coverage: 3 / 6,
      rawRate: 1 / 6,
    })
    expect(s.resolved + s.modelMiss + s.infraInvalid + s.ambiguous + s.missing).toBe(s.assigned)
    expect(s.gradingValid).toBe(s.resolved + s.modelMiss)
  })

  test("rates are null (never fabricated) when their denominator is zero", () => {
    const s = summarizeOfficialGrade(okReceipt(build([], [])))
    expect([s.officialValidRate, s.coverage, s.rawRate]).toEqual([null, null, null])
  })

  test("a shrunken valid denominator cannot hide as a better score", () => {
    const wide = summarizeOfficialGrade(okReceipt(build(HAPPY.assigned, HAPPY.dispositions)))
    const narrow = summarizeOfficialGrade(
      okReceipt(build(HAPPY.assigned, [HAPPY.dispositions[0] as OfficialGradeDisposition])),
    )
    expect(narrow.officialValidRate).toBe(1)
    // ... but coverage collapses in the SAME summary, so it is impossible to
    // report the flattering rate without the loss beside it
    expect(narrow.coverage).toBeLessThan(wide.coverage ?? 1)
    expect(narrow.missing).toBe(5)
  })
})

describe("official-grade receipt — round trip", () => {
  test("serialize→parse preserves every disposition and the evaluator metadata", () => {
    const original = okReceipt(build(HAPPY.assigned, HAPPY.dispositions))
    const json = serializeOfficialGradeReceipt(original)
    const reparsed = parseOfficialGradeReceipt(JSON.parse(json))
    const receipt = okReceipt(reparsed)

    expect(receipt.assignedInstanceIds).toEqual(original.assignedInstanceIds)
    expect(receipt.dispositionsByInstanceId.size).toBe(original.dispositionsByInstanceId.size)
    for (const [id, d] of original.dispositionsByInstanceId) {
      expect([id, receipt.dispositionsByInstanceId.get(id)]).toEqual([id, d])
    }
    expect(receipt.evaluator).toEqual(original.evaluator)
    expect(deriveMissingInstanceIds(receipt)).toEqual(deriveMissingInstanceIds(original))
    expect(summarizeOfficialGrade(receipt)).toEqual(summarizeOfficialGrade(original))
  })

  test("a round trip that dropped a disposition would be caught, not absorbed", () => {
    const original = okReceipt(build(HAPPY.assigned, HAPPY.dispositions))
    const doc = JSON.parse(serializeOfficialGradeReceipt(original)) as {
      dispositions: unknown[]
    }
    doc.dispositions = doc.dispositions.slice(1)
    const shrunk = okReceipt(parseOfficialGradeReceipt(doc))
    // it does NOT silently look identical: coverage moves and missing grows
    expect(deriveMissingInstanceIds(shrunk).length).toBe(
      deriveMissingInstanceIds(original).length + 1,
    )
    expect(summarizeOfficialGrade(shrunk)).not.toEqual(summarizeOfficialGrade(original))
  })

  test("parsing a document with an unknown state fails closed", () => {
    const doc = JSON.parse(
      serializeOfficialGradeReceipt(okReceipt(build(HAPPY.assigned, HAPPY.dispositions))),
    ) as { dispositions: { state: string }[] }
    const first = doc.dispositions[0]
    if (first === undefined) throw new Error("fixture gap")
    first.state = "partially_resolved"
    expect(codesOf(parseOfficialGradeReceipt(doc))).toContain("state_unknown")
  })
})

describe("official-grade receipt — legacy buckets are DERIVED, not a second truth", () => {
  test("projection maps every state through one declared table", () => {
    const receipt = okReceipt(build(HAPPY.assigned, HAPPY.dispositions))
    const view = projectLegacyBuckets(receipt)
    expect(view).toEqual({
      resolved: ["i-1"],
      unresolved: ["i-2"],
      errored: ["i-4", "i-5"],
      emptyPatch: ["i-3"],
      droppedMissing: ["i-6"],
    })
    expect(Object.keys(LEGACY_BUCKET_BY_STATE).sort()).toEqual([
      "ambiguous",
      "infra_invalid",
      "model_miss",
      "resolved",
    ])
  })

  test("the projection is frozen and mutating it cannot reach the receipt", () => {
    const receipt = okReceipt(build(HAPPY.assigned, HAPPY.dispositions))
    const view = projectLegacyBuckets(receipt)
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.resolved)).toBe(true)
    expect(() => {
      ;(view.resolved as string[]).push("i-2")
    }).toThrow()
    // re-projecting the SAME receipt yields the same answer — no write-back
    expect(projectLegacyBuckets(receipt)).toEqual(view)
    expect(summarizeOfficialGrade(receipt).resolved).toBe(1)
  })

  test("the projection is lossy on purpose and SAYS SO — ambiguous and missing", () => {
    const receipt = okReceipt(build(HAPPY.assigned, HAPPY.dispositions))
    const view = projectLegacyBuckets(receipt)
    const inFourArrays = [...view.resolved, ...view.unresolved, ...view.errored, ...view.emptyPatch]
    // the four legacy arrays cannot represent `missing` at all
    expect(inFourArrays).not.toContain("i-6")
    expect(view.droppedMissing).toEqual(["i-6"])
    // and `ambiguous` is NOT laundered into `unresolved` (which would score it)
    expect(view.unresolved).not.toContain("i-5")
  })
})

/**
 * WHICH IMAGE produced a verdict. A pass-rate document says an instance
 * resolved; it does not say what it ran inside, and against a mutable tag two
 * graders of identical evaluator bytes are not the same experiment.
 *
 * The pins were captured — and already had the power to FAIL a run — for a
 * commit before they reached the receipt at all: the port declared no `images`
 * field and an `as Parameters<…>` cast in the profile made the mismatch
 * compile. So these tests assert the SERIALIZED document, never an in-memory
 * value, and the anti-vacuity case below removes the carry to prove it binds.
 */
describe("image pins on the receipt", () => {
  const DIGEST = `swebench/x@sha256:${"a".repeat(64)}`
  const IMAGES = [{ instanceId: "a__b-1", imageName: "swebench/x:a__b-1", repoDigest: DIGEST }]
  const withImages = (images: unknown): OfficialGradeReceiptResult =>
    buildOfficialGradeReceipt({
      assignedInstanceIds: ["a__b-1"],
      dispositions: [dispo({ id: "a__b-1", state: "resolved", reason: "official_resolved" })],
      evaluator: evaluatorMeta(),
      images: images as never,
    })

  test("a valid pin survives into the SERIALIZED document", () => {
    const json = serializeOfficialGradeReceipt(okReceipt(withImages(IMAGES)))
    expect(json).toContain(DIGEST)
    expect(JSON.parse(json).images).toEqual(IMAGES)
  })

  test("…and survives a serialize → parse ROUND TRIP", () => {
    const json = serializeOfficialGradeReceipt(okReceipt(withImages(IMAGES)))
    const back = parseOfficialGradeReceipt(JSON.parse(json))
    expect(back.ok, "a receipt carrying valid pins failed to re-parse").toBe(true)
    // a re-read receipt that dropped the pins would report provenance it no
    // longer has the moment anything reads it back off disk
    expect(okReceipt(back).images).toEqual(IMAGES)
  })

  test("PAIRED CONTROL: a grader that captured none is byte-identical to before", () => {
    const json = serializeOfficialGradeReceipt(okReceipt(withImages(undefined)))
    expect(Object.hasOwn(JSON.parse(json), "images")).toBe(false)
    expect(json).toBe(
      serializeOfficialGradeReceipt(
        okReceipt(
          build(
            ["a__b-1"],
            [dispo({ id: "a__b-1", state: "resolved", reason: "official_resolved" })],
          ),
        ),
      ),
    )
  })

  test.each([
    [
      "a bare tag, not a digest",
      [{ instanceId: "a__b-1", imageName: "x", repoDigest: "x:latest" }],
    ],
    ["a truncated digest", [{ instanceId: "a__b-1", imageName: "x", repoDigest: "x@sha256:abc" }]],
    [
      "a non-hex digest",
      [{ instanceId: "a__b-1", imageName: "x", repoDigest: `x@sha256:${"z".repeat(64)}` }],
    ],
    ["an empty digest", [{ instanceId: "a__b-1", imageName: "x", repoDigest: "" }]],
    ["no instance to attribute it to", [{ instanceId: "", imageName: "x", repoDigest: DIGEST }]],
    ["no image name", [{ instanceId: "a__b-1", imageName: "  ", repoDigest: DIGEST }]],
    ["the same instance pinned twice", [IMAGES[0], IMAGES[0]]],
  ])("REFUSES %s rather than recording unreplayable provenance", (_label, images) => {
    const r = withImages(images)
    expect(r.ok, "an unusable image pin was accepted onto the receipt").toBe(false)
    if (r.ok) return
    expect(r.failures.map((f) => f.code)).toContain("image_ref_invalid")
  })

  test("a refused pin refuses the WHOLE receipt — no partial provenance", () => {
    const r = withImages([
      IMAGES[0],
      { instanceId: "a__b-2", imageName: "x", repoDigest: "x:latest" },
    ])
    expect(r.ok).toBe(false)
  })
})

describe("the MERGED campaign receipt keeps its image pins", () => {
  const DIGEST = (c: string) => `repo/x@sha256:${c.repeat(64)}`

  const chunk = (id: string, c: string): OfficialGradeReceipt => {
    const built = buildOfficialGradeReceipt({
      assignedInstanceIds: [id],
      dispositions: [dispo({ id, state: "resolved", reason: "official_resolved" })],
      evaluator: evaluatorMeta(),
      images: [{ instanceId: id, imageName: "repo/x", repoDigest: DIGEST(c) }],
    })
    return okReceipt(built)
  }

  test("🔴 merging two chunks preserves BOTH chunks' pins", async () => {
    // The per-chunk receipt carried them; the CAMPAIGN receipt — the artifact
    // every downstream surface reads — dropped them, so "wired end to end" held
    // only for the single-chunk file.
    const { mergeOfficialGradeReceipts } = await import("@/runner/batch/eval/official-grade")
    const merged = mergeOfficialGradeReceipts({
      receipts: [chunk("a__b-1", "a"), chunk("c__d-2", "b")],
    })
    expect(merged.ok, "the merge refused two valid receipts").toBe(true)
    if (!merged.ok) return
    expect(merged.receipt.images, "the merged receipt lost every image pin").toEqual([
      { instanceId: "a__b-1", imageName: "repo/x", repoDigest: DIGEST("a") },
      { instanceId: "c__d-2", imageName: "repo/x", repoDigest: DIGEST("b") },
    ])
  })

  test("PAIRED CONTROL: merging receipts that carried none stays byte-identical", async () => {
    const { mergeOfficialGradeReceipts } = await import("@/runner/batch/eval/official-grade")
    const plain = (id: string) =>
      okReceipt(build([id], [dispo({ id, state: "resolved", reason: "official_resolved" })]))
    const merged = mergeOfficialGradeReceipts({ receipts: [plain("a__b-1"), plain("c__d-2")] })
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(Object.hasOwn(JSON.parse(serializeOfficialGradeReceipt(merged.receipt)), "images")).toBe(
      false,
    )
  })
})

describe("a tampered `images` value is refused, not dropped", () => {
  test("🔴 a non-array `images` fails the parse instead of vanishing", () => {
    const doc = JSON.parse(
      serializeOfficialGradeReceipt(
        okReceipt(
          build(
            ["a__b-1"],
            [dispo({ id: "a__b-1", state: "resolved", reason: "official_resolved" })],
          ),
        ),
      ),
    ) as Record<string, unknown>
    doc.images = "TOTALLY NOT AN ARRAY"
    const back = parseOfficialGradeReceipt(doc)
    expect(back.ok, "a corrupted images value was silently discarded").toBe(false)
  })
})

describe("evaluator metadata is validated all the way down", () => {
  test("🔴 a receipt whose evaluator lost its outputArtifact is REFUSED at parse", () => {
    // `validateEvaluator` checked id/commit/path/sha256/cwd/argv/streams but not
    // `outputArtifact`, and the parser cast `doc.evaluator` unvalidated. A
    // persisted receipt missing that key parsed `ok` and then crashed the report
    // aggregator with "undefined is not an object" — a stack trace where an
    // `evaluator_meta_invalid` belonged, which is the exact defect this
    // function's own comment says it fixed one field higher up.
    const doc = JSON.parse(
      serializeOfficialGradeReceipt(
        okReceipt(
          build(
            ["a__b-1"],
            [dispo({ id: "a__b-1", state: "resolved", reason: "official_resolved" })],
          ),
        ),
      ),
    ) as { evaluator: Record<string, unknown> }
    delete doc.evaluator.outputArtifact
    const back = parseOfficialGradeReceipt(doc)
    expect(back.ok, "an evaluator with no output artifact parsed clean").toBe(false)
    if (back.ok) return
    expect(back.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
  })

  test("PAIRED CONTROL: an explicit null outputArtifact is still legal", () => {
    // `null` is the declared shape for "the evaluator produced no artifact" —
    // absent is the corruption, null is a value.
    const built = buildOfficialGradeReceipt({
      assignedInstanceIds: ["a__b-1"],
      dispositions: [dispo({ id: "a__b-1", state: "resolved", reason: "official_resolved" })],
      evaluator: { ...evaluatorMeta(), outputArtifact: null },
    })
    expect(built.ok).toBe(true)
  })
})
