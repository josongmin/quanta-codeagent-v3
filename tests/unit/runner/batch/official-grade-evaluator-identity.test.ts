/**
 * The evaluator identity a receipt carries is REPLAY EVIDENCE, and every field
 * of it has to be present for the claim to mean anything.
 *
 * aug-23 audit: `validateEvaluator` checked `evaluatorId`, `upstreamCommit`,
 * `evaluatorPath`, `cwd`, `argv`, `stdout` and `stderr` — but NOT
 * `evaluatorSha256`. That is the one field that says WHICH BYTES graded the
 * run: a commit names a tree, a path names a location, but only the hash pins
 * the executable that produced these verdicts. A receipt could therefore assert
 * "here is how to replay me" while naming no evaluator content at all, and the
 * refusal message ("id, commit, path, cwd, argv, and raw streams are all
 * required replay evidence") did not even list it, so the omission read as
 * deliberate rather than missed.
 *
 * The type declares `readonly evaluatorSha256: string`, so this was a runtime
 * hole under a compile-time promise — the shape most likely to be trusted.
 *
 * These tests observe the REAL builder and the REAL parser. Both doors matter:
 * a receipt can be BUILT in-process or PARSED back from disk, and a hole in
 * either one admits an unreplayable receipt.
 */
import { describe, expect, test } from "bun:test"
import {
  buildOfficialGradeReceipt,
  type OfficialGradeEvaluatorMeta,
  parseOfficialGradeReceipt,
  serializeOfficialGradeReceipt,
} from "@/runner/batch/eval/official-grade"

const REAL_SHA = "af2ee720de8a51a921f4af2617937c45f4e3b983549b640756b0fa8b2c1bf42d"

const meta = (over: Partial<OfficialGradeEvaluatorMeta> = {}): OfficialGradeEvaluatorMeta =>
  ({
    evaluatorId: "swe-bench-promax/test_run.py",
    upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
    evaluatorPath: "/pinned/src/evaluation/test_run.py",
    evaluatorSha256: REAL_SHA,
    argv: ["python3", "/pinned/src/evaluation/test_run.py", "--workers", "1"],
    cwd: "/pinned",
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...over,
  }) as OfficialGradeEvaluatorMeta

const build = (evaluator: OfficialGradeEvaluatorMeta) =>
  buildOfficialGradeReceipt({
    assignedInstanceIds: ["repo__inst-1"],
    dispositions: [
      {
        instanceId: "repo__inst-1",
        state: "resolved",
        reason: "official_resolved",
        gradingValid: true,
        // A scored outcome must cite evidence — the receipt refuses a `resolved`
        // with no raw artifact, which is its own (correct) rule.
        rawArtifact: { path: "/out/pass-rate.json", sha256: "b".repeat(64), byteLength: 1041790 },
        // The disposition-level summary is REQUIRED by the type. All-null is the
        // "grader emitted nothing usable" shape, which is what these cases mean:
        // they exercise the receipt-level evaluator IDENTITY guard, not the
        // per-instance pass summary.
        evaluator: { passed: null, model: null, golden: null },
      },
    ],
    evaluator,
  })

/** Every identity field, so the guard is proven field-by-field rather than by
 *  one representative. A guard that checks six of seven passes a single-field
 *  test whenever that test happens to pick a checked field. */
const IDENTITY_FIELDS = [
  "evaluatorId",
  "upstreamCommit",
  "evaluatorPath",
  "evaluatorSha256",
  "cwd",
] as const

describe("official-grade receipt — evaluator identity is complete replay evidence", () => {
  test("KNOWN-ITEM FLOOR: a complete identity BUILDS", () => {
    const r = build(meta())
    expect(r.ok).toBe(true)
  })

  test("every identity string field is required — blank refuses, per field", () => {
    for (const field of IDENTITY_FIELDS) {
      const blank = build(meta({ [field]: "" } as Partial<OfficialGradeEvaluatorMeta>))
      expect(blank.ok, `blank ${field} was ACCEPTED`).toBe(false)
      if (blank.ok) continue
      expect(blank.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")

      // whitespace is blank too — a hash of spaces pins nothing
      const spaces = build(meta({ [field]: "   " } as Partial<OfficialGradeEvaluatorMeta>))
      expect(spaces.ok, `whitespace ${field} was ACCEPTED`).toBe(false)
    }
  })

  test("the refusal message NAMES the evaluator hash, so the gap cannot read as deliberate", () => {
    const r = build(meta({ evaluatorSha256: "" }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    const message = r.failures.map((f) => f.message).join(" ")
    // The old message listed "id, commit, path, cwd, argv, and raw streams" and
    // silently omitted the hash — which is how the hole survived review.
    expect(message).toMatch(/hash|sha256/i)
  })

  test("the PARSE door refuses it too — a receipt read back from disk is held to the same bar", () => {
    const good = build(meta())
    expect(good.ok).toBe(true)
    if (!good.ok) return
    const doc = JSON.parse(serializeOfficialGradeReceipt(good.receipt)) as {
      evaluator: Record<string, unknown>
    }
    // PAIRED CONTROL: the untampered document parses.
    expect(parseOfficialGradeReceipt(doc).ok).toBe(true)

    doc.evaluator.evaluatorSha256 = ""
    const parsed = parseOfficialGradeReceipt(doc)
    expect(parsed.ok, "a persisted receipt with a blank evaluator hash was ACCEPTED").toBe(false)
    if (parsed.ok) return
    expect(parsed.failures.map((f) => f.code)).toContain("evaluator_meta_invalid")
  })
})
