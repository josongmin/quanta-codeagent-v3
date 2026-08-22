/**
 * PMX-03 — the gold sentinel contract (pure part).
 *
 * The preflight must prove GOLDEN authority, not model skill. Copying the
 * golden patch into `model_patch` would make model and golden output identical,
 * which is exactly the input upstream's equal-output SUCCESS promotion looks
 * for — a vacuous 100% preflight. The sentinel is therefore a deterministic,
 * campaign-unique, GUARANTEED non-applying deletion hunk.
 *
 * Proving the sentinel path absent in every selected image is PMX-04 (live).
 */
import { describe, expect, test } from "bun:test"
import {
  buildGoldSentinelPatch,
  buildProMaxOfficialGradeReceipt,
  evaluateGoldSentinelGate,
  goldSentinelPathToken,
} from "@/apps/bench/harness/promax"
import type { OfficialGradeReceipt } from "@/runner/batch/eval/official-grade"
import {
  evaluatorIdentity,
  OUTPUT_PATH,
  officialDocument,
  officialRow,
  type RowSpec,
} from "./promax-official-fixtures"

const receiptFor = (specs: readonly RowSpec[]): OfficialGradeReceipt => {
  const text = officialDocument(specs.map(officialRow))
  const r = buildProMaxOfficialGradeReceipt({
    assignedInstanceIds: specs.map((s) => s.instanceId),
    evaluator: evaluatorIdentity(),
    run: { exitCode: 0, stdout: "", stderr: "", outputJsonText: text, outputPath: OUTPUT_PATH },
  })
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(",")}`)
  return r.receipt
}

describe("gold sentinel patch", () => {
  test("is deterministic per campaign and unique across campaigns", () => {
    expect(buildGoldSentinelPatch("pmx-7-2026-08-22")).toBe(
      buildGoldSentinelPatch("pmx-7-2026-08-22"),
    )
    expect(buildGoldSentinelPatch("pmx-7")).not.toBe(buildGoldSentinelPatch("pmx-14"))
    expect(goldSentinelPathToken("pmx-7")).not.toBe(goldSentinelPathToken("pmx-14"))
  })

  test("is a non-empty deletion hunk against a campaign-unique path", () => {
    const patch = buildGoldSentinelPatch("pmx-7")
    const token = goldSentinelPathToken("pmx-7")
    expect(patch.length).toBeGreaterThan(0)
    expect(patch).toContain(token)
    expect(patch).toContain("deleted file mode")
    expect(patch).toContain("+++ /dev/null")
    expect(patch).toContain("@@ -1 +0,0 @@")
    expect(patch.endsWith("\n")).toBe(true)
    // an EMPTY patch would `git apply` cleanly and defeat the whole preflight
    expect(patch.trim()).not.toBe("")
  })

  test("names a path no repository can plausibly contain", () => {
    const patch = buildGoldSentinelPatch("pmx-7")
    const token = goldSentinelPathToken("pmx-7")
    expect(token).toMatch(/^[0-9a-f]{16}$/)
    expect(patch).toContain(`.quanta-gold-sentinel-${token}/absent`)
  })
})

describe("gold sentinel gate", () => {
  const sentinelRow = (instanceId: string, overrides: Partial<RowSpec> = {}): RowSpec => ({
    instanceId,
    golden: "success",
    model: "apply_failed",
    ...overrides,
  })

  test("passes when EVERY assigned instance is golden=success and model=apply_failed", () => {
    const gate = evaluateGoldSentinelGate(receiptFor([sentinelRow("i-1"), sentinelRow("i-2")]))
    expect(gate).toEqual({ ok: true, failures: [] })
  })

  test("IGNORES top-level `passed` — a forged true does not change the verdict", () => {
    const forged = receiptFor([sentinelRow("i-1", { passed: true })])
    expect(evaluateGoldSentinelGate(forged).ok).toBe(true)
    const d = forged.dispositionsByInstanceId.get("i-1")
    expect(d?.evaluator.passed).toBe(true) // retained for audit ...
    expect(d?.state).toBe("model_miss") // ... but it did not forge `resolved`
  })

  test("a golden non-success FAILS the gate — that is the whole point", () => {
    for (const golden of ["apply_failed", "non zero exit", "timeout_eval", "need_human_review"]) {
      const gate = evaluateGoldSentinelGate(
        receiptFor([sentinelRow("i-1", { golden } as Partial<RowSpec>)]),
      )
      expect([golden, gate.ok]).toEqual([golden, false])
      expect(gate.failures.map((f) => f.code)).toContain("golden_not_success")
    }
  })

  test("the sentinel CANNOT become resolved through the equal-output path", () => {
    // Upstream's promotion trigger: identical stdout, identical stderr, identical
    // reason. Reproduce that byte-for-byte on our side of the boundary.
    const identical = { stdout: "IDENTICAL-OUT", stderr: "IDENTICAL-ERR" }
    const receipt = receiptFor([
      {
        instanceId: "i-1",
        golden: "success",
        model: "apply_failed",
        modelSide: identical,
        goldenSide: identical,
        passed: true,
      },
    ])
    const d = receipt.dispositionsByInstanceId.get("i-1")
    expect(d?.state).toBe("model_miss")
    expect(d?.reason).toBe("patch_apply_failed")
    expect(evaluateGoldSentinelGate(receipt).ok).toBe(true)
  })

  test("a sentinel that upstream DID promote to model success fails the gate loudly", () => {
    // If a future pin actually writes the promotion into `final_result`, the
    // preflight must stop the campaign rather than report a vacuous 100%.
    const receipt = receiptFor([sentinelRow("i-1", { model: "success" })])
    expect(receipt.dispositionsByInstanceId.get("i-1")?.state).toBe("resolved")
    const gate = evaluateGoldSentinelGate(receipt)
    expect(gate.ok).toBe(false)
    expect(gate.failures.map((f) => f.code)).toEqual(["model_not_apply_failed"])
  })

  test("an assigned instance with NO row fails the gate as uncovered, not as pass", () => {
    const text = officialDocument([officialRow(sentinelRow("i-1"))])
    const r = buildProMaxOfficialGradeReceipt({
      assignedInstanceIds: ["i-1", "i-2"],
      evaluator: evaluatorIdentity(),
      run: { exitCode: 0, stdout: "", stderr: "", outputJsonText: text, outputPath: OUTPUT_PATH },
    })
    if (!r.ok) throw new Error("fixture gap")
    const gate = evaluateGoldSentinelGate(r.receipt)
    expect(gate.ok).toBe(false)
    expect(gate.failures.map((f) => [f.instanceId, f.code])).toEqual([["i-2", "sentinel_missing"]])
  })

  test("failures accumulate across instances instead of short-circuiting", () => {
    const gate = evaluateGoldSentinelGate(
      receiptFor([
        sentinelRow("i-1"),
        sentinelRow("i-2", { golden: "non zero exit" }),
        sentinelRow("i-3", { model: "success" }),
      ]),
    )
    expect(gate.failures.map((f) => f.instanceId)).toEqual(["i-2", "i-3"])
  })
})
