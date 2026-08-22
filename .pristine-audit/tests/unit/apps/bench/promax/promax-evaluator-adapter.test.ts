/**
 * PMX-03 — the adapter that turns ONE pinned-evaluator run into the generic
 * official-grade receipt.
 *
 * The two failure modes this file exists to refuse:
 *  1. an infrastructure hole (crashed evaluator, no output, schema drift)
 *     being laundered into a model result — or vice versa;
 *  2. grader-only bytes (golden stdout/stderr) riding into the per-instance
 *     disposition, where an agent-visible surface could later read them.
 */
import { describe, expect, test } from "bun:test"
import { buildProMaxOfficialGradeReceipt } from "@/apps/bench/harness/promax"
import type { OfficialGradeReceiptResult } from "@/runner/batch/eval/official-grade"
import {
  deriveMissingInstanceIds,
  summarizeOfficialGrade,
} from "@/runner/batch/eval/official-grade"
import {
  evaluatorIdentity,
  type JsonRecord,
  OUTPUT_PATH,
  officialDocument,
  officialRow,
  oracleSha256,
  type RowSpec,
  UPSTREAM_FINAL_RESULTS,
} from "./promax-official-fixtures"

interface RunOverrides {
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly outputJsonText?: string | null
}

const grade = (
  assignedInstanceIds: readonly string[],
  outputText: string | null,
  run: RunOverrides = {},
): OfficialGradeReceiptResult =>
  buildProMaxOfficialGradeReceipt({
    assignedInstanceIds,
    evaluator: evaluatorIdentity(),
    run: {
      exitCode: run.exitCode === undefined ? 0 : run.exitCode,
      stdout: run.stdout ?? "",
      stderr: run.stderr ?? "",
      outputJsonText: run.outputJsonText === undefined ? outputText : run.outputJsonText,
      outputPath: OUTPUT_PATH,
    },
  })

const okOf = (r: OfficialGradeReceiptResult) => {
  if (!r.ok) throw new Error(`expected ok: ${r.failures.map((f) => f.code).join(",")}`)
  return r.receipt
}

/** One row per upstream state on the model side, all under golden success. */
const FULL_MODEL_SWEEP: readonly RowSpec[] = UPSTREAM_FINAL_RESULTS.map((model, i) => ({
  instanceId: `m-${i}`,
  golden: "success",
  model,
}))

/** One row per upstream state on the golden side, all with a passing model. */
const FULL_GOLDEN_SWEEP: readonly RowSpec[] = UPSTREAM_FINAL_RESULTS.map((golden, i) => ({
  instanceId: `g-${i}`,
  golden,
  model: "success",
}))

describe("PMX-03 adapter — happy path over the full state sweep", () => {
  const specs = [...FULL_MODEL_SWEEP, ...FULL_GOLDEN_SWEEP]
  const text = officialDocument(specs.map(officialRow))
  const receipt = okOf(
    grade(
      specs.map((s) => s.instanceId),
      text,
    ),
  )

  test("ANTI-VACUUM count floor: 7 model states × 7 golden states are exercised", () => {
    expect(new Set(specs.map((s) => s.model)).size).toBe(7)
    expect(new Set(specs.map((s) => s.golden)).size).toBe(7)
    expect(receipt.dispositionsByInstanceId.size).toBe(14)
  })

  test("all four outcome states appear and none is `missing`", () => {
    const states = new Set([...receipt.dispositionsByInstanceId.values()].map((d) => d.state))
    expect([...states].sort()).toEqual(["ambiguous", "infra_invalid", "model_miss", "resolved"])
    expect(deriveMissingInstanceIds(receipt)).toEqual([])
  })

  test("every disposition points at the SAME raw artifact with a real digest", () => {
    for (const d of receipt.dispositionsByInstanceId.values()) {
      expect(d.rawArtifact).toEqual({
        path: OUTPUT_PATH,
        sha256: oracleSha256(text),
        byteLength: Buffer.byteLength(text, "utf8"),
      })
    }
    expect(receipt.evaluator.outputArtifact?.sha256).toBe(oracleSha256(text))
  })

  test("`passed` is retained for audit but never alone the authority", () => {
    const resolved = receipt.dispositionsByInstanceId.get("m-0")
    expect(resolved?.state).toBe("resolved")
    expect(resolved?.evaluator.passed).toBe(true)
    for (const d of receipt.dispositionsByInstanceId.values()) {
      expect(typeof d.evaluator.passed).toBe("boolean")
    }
  })

  test("NO grader-only stdout/stderr rides into a disposition", () => {
    const serialized = JSON.stringify([...receipt.dispositionsByInstanceId.values()])
    expect(serialized).not.toContain("SYNTHETIC-STDOUT")
    expect(serialized).not.toContain("SYNTHETIC-STDERR")
    for (const d of receipt.dispositionsByInstanceId.values()) {
      expect(Object.keys(d.evaluator.golden ?? {})).not.toContain("stdout")
      expect(Object.keys(d.evaluator.model ?? {})).not.toContain("stderr")
    }
  })

  test("the verbatim upstream final_result strings survive for audit", () => {
    expect(receipt.dispositionsByInstanceId.get("m-5")?.evaluator.model?.finalResult).toBe(
      "non zero exit",
    )
    expect(receipt.dispositionsByInstanceId.get("g-5")?.evaluator.golden?.finalResult).toBe(
      "non zero exit",
    )
  })
})

describe("PMX-03 adapter — `passed` can never forge `resolved`", () => {
  test("passed:true with a non-success MODEL state is still a model miss", () => {
    for (const model of UPSTREAM_FINAL_RESULTS) {
      if (model === "success") continue
      const specs: readonly RowSpec[] = [
        { instanceId: "x-1", golden: "success", model, passed: true },
      ]
      const receipt = okOf(grade(["x-1"], officialDocument(specs.map(officialRow))))
      const d = receipt.dispositionsByInstanceId.get("x-1")
      expect([model, d?.state]).not.toEqual([model, "resolved"])
      expect(d?.evaluator.passed).toBe(true)
    }
  })

  test("passed:true with a non-success GOLDEN state is still infra-invalid/ambiguous", () => {
    for (const golden of UPSTREAM_FINAL_RESULTS) {
      if (golden === "success") continue
      const specs: readonly RowSpec[] = [
        { instanceId: "x-1", golden, model: "success", passed: true },
      ]
      const receipt = okOf(grade(["x-1"], officialDocument(specs.map(officialRow))))
      const d = receipt.dispositionsByInstanceId.get("x-1")
      expect([golden, d?.state]).not.toEqual([golden, "resolved"])
      expect([golden, d?.gradingValid]).toEqual([golden, false])
    }
  })

  test("passed:false with success/success is STILL resolved (nested state rules)", () => {
    const specs: readonly RowSpec[] = [
      { instanceId: "x-1", golden: "success", model: "success", passed: false },
    ]
    const receipt = okOf(grade(["x-1"], officialDocument(specs.map(officialRow))))
    expect(receipt.dispositionsByInstanceId.get("x-1")?.state).toBe("resolved")
  })
})

describe("PMX-03 adapter — schema drift fails closed per row", () => {
  const oneBadRow = (mutate: (row: JsonRecord) => void): OfficialGradeReceiptResult => {
    const row = officialRow({ instanceId: "x-1", golden: "success", model: "success" })
    mutate(row)
    return grade(["x-1"], officialDocument([row]))
  }

  test("an unknown final_result becomes infra_invalid / schema_invalid", () => {
    const receipt = okOf(
      oneBadRow((row) => {
        ;(row.model as JsonRecord).final_result = "kinda_passed"
      }),
    )
    const d = receipt.dispositionsByInstanceId.get("x-1")
    expect([d?.state, d?.reason]).toEqual(["infra_invalid", "schema_invalid"])
    // the offending string is kept verbatim so an operator can see the drift
    expect(d?.evaluator.model?.finalResult).toBe("kinda_passed")
  })

  test("upstream's own `not run` fallback is schema_invalid, not a silent pass", () => {
    const receipt = okOf(
      oneBadRow((row) => {
        ;(row.golden as JsonRecord).final_result = "not run"
      }),
    )
    expect(receipt.dispositionsByInstanceId.get("x-1")?.reason).toBe("schema_invalid")
  })

  test("an absent model or golden object is schema_invalid", () => {
    for (const key of ["model", "golden"]) {
      const receipt = okOf(
        oneBadRow((row) => {
          delete row[key]
        }),
      )
      expect([key, receipt.dispositionsByInstanceId.get("x-1")?.reason]).toEqual([
        key,
        "schema_invalid",
      ])
    }
  })

  test("a non-boolean `passed` is schema_invalid and is NOT coerced", () => {
    const receipt = okOf(
      oneBadRow((row) => {
        row.passed = "true"
      }),
    )
    const d = receipt.dispositionsByInstanceId.get("x-1")
    expect(d?.reason).toBe("schema_invalid")
    expect(d?.evaluator.passed).toBe(null)
  })

  test("one malformed row does not contaminate its healthy neighbours", () => {
    const good = officialRow({ instanceId: "ok-1", golden: "success", model: "success" })
    const bad = officialRow({ instanceId: "bad-1", golden: "success", model: "success" })
    ;(bad.model as JsonRecord).final_result = 7
    const receipt = okOf(grade(["ok-1", "bad-1"], officialDocument([good, bad])))
    expect(receipt.dispositionsByInstanceId.get("ok-1")?.state).toBe("resolved")
    expect(receipt.dispositionsByInstanceId.get("bad-1")?.state).toBe("infra_invalid")
  })

  test("a row for an UNASSIGNED instance fails the whole receipt closed", () => {
    const stray = officialRow({ instanceId: "not-assigned", golden: "success", model: "success" })
    const r = grade(["ok-1"], officialDocument([stray]))
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.failures.map((f) => f.code)).toContain("disposition_unassigned")
  })

  test("a duplicated instance row fails the whole receipt closed", () => {
    const row = officialRow({ instanceId: "ok-1", golden: "success", model: "success" })
    const r = grade(["ok-1"], officialDocument([row, row]))
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.failures.map((f) => f.code)).toContain("disposition_duplicated")
  })

  test("a row with no usable instance_id cannot be attributed and is refused", () => {
    const row = officialRow({ instanceId: "ok-1", golden: "success", model: "success" })
    delete row.instance_id
    const r = grade(["ok-1"], officialDocument([row]))
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.failures.map((f) => f.code)).toContain("row_unattributable")
  })
})

describe("PMX-03 adapter — evaluator-level failures are infrastructure, with raw evidence", () => {
  const RAW_OUT = "execute: docker pull key4127/refactor-dockerhub:i-1\n"
  const RAW_ERR = "Traceback (most recent call last):\nRuntimeError: boom\n"

  test("no output file at all ⇒ every assigned id is infra_invalid / evaluator_no_output", () => {
    const receipt = okOf(
      grade(["i-1", "i-2"], null, { exitCode: 0, stdout: RAW_OUT, stderr: RAW_ERR }),
    )
    for (const id of ["i-1", "i-2"]) {
      const d = receipt.dispositionsByInstanceId.get(id)
      expect([id, d?.state, d?.reason]).toEqual([id, "infra_invalid", "evaluator_no_output"])
      expect(d?.rawArtifact).toBe(null)
      expect(d?.gradingValid).toBe(false)
    }
    // raw stdout/stderr are RETAINED, not truncated away
    expect(receipt.evaluator.stdout).toBe(RAW_OUT)
    expect(receipt.evaluator.stderr).toBe(RAW_ERR)
    expect(receipt.evaluator.exitCode).toBe(0)
  })

  test("a nonzero exit ⇒ infra_invalid / evaluator_nonzero_exit, raw streams kept", () => {
    const receipt = okOf(grade(["i-1"], "[]", { exitCode: 2, stdout: RAW_OUT, stderr: RAW_ERR }))
    const d = receipt.dispositionsByInstanceId.get("i-1")
    expect([d?.state, d?.reason]).toEqual(["infra_invalid", "evaluator_nonzero_exit"])
    expect(receipt.evaluator.exitCode).toBe(2)
    expect(receipt.evaluator.stderr).toBe(RAW_ERR)
  })

  test("a killed evaluator (null exit) ⇒ infra_invalid / evaluator_unavailable", () => {
    const receipt = okOf(grade(["i-1"], "[]", { exitCode: null, stderr: RAW_ERR }))
    const d = receipt.dispositionsByInstanceId.get("i-1")
    expect([d?.state, d?.reason]).toEqual(["infra_invalid", "evaluator_unavailable"])
  })

  test("an output file that is not a JSON array ⇒ infra_invalid for every assigned id", () => {
    for (const junk of ["", "not json", "{}", "null", '{"i-1": {}}']) {
      const receipt = okOf(grade(["i-1"], junk))
      const d = receipt.dispositionsByInstanceId.get("i-1")
      expect([junk, d?.state, d?.reason]).toEqual([junk, "infra_invalid", "schema_invalid"])
    }
  })

  test("evaluator-level infra does NOT become `missing` — we observed the failure", () => {
    const receipt = okOf(grade(["i-1", "i-2"], null, { exitCode: 1 }))
    expect(deriveMissingInstanceIds(receipt)).toEqual([])
    expect(summarizeOfficialGrade(receipt)).toEqual({
      assigned: 2,
      resolved: 0,
      modelMiss: 0,
      infraInvalid: 2,
      ambiguous: 0,
      missing: 0,
      gradingValid: 0,
      officialValidRate: null,
      coverage: 0,
      rawRate: 0,
    })
  })

  test("an assigned id absent from a healthy document IS missing (coverage-derived)", () => {
    const text = officialDocument([
      officialRow({ instanceId: "i-1", golden: "success", model: "success" }),
    ])
    const receipt = okOf(grade(["i-1", "i-2", "i-3"], text))
    expect(deriveMissingInstanceIds(receipt)).toEqual(["i-2", "i-3"])
    expect(summarizeOfficialGrade(receipt).coverage).toBe(1 / 3)
  })
})

describe("PMX-03 adapter — empty predictions are model misses, never infra holes", () => {
  test("an empty-patch instance with golden success is a model miss with a reason", () => {
    const text = officialDocument([
      officialRow({ instanceId: "e-1", golden: "success", model: "non zero exit" }),
    ])
    const r = buildProMaxOfficialGradeReceipt({
      assignedInstanceIds: ["e-1"],
      evaluator: evaluatorIdentity(),
      run: { exitCode: 0, stdout: "", stderr: "", outputJsonText: text, outputPath: OUTPUT_PATH },
      emptyPredictionInstanceIds: ["e-1"],
    })
    const d = okOf(r).dispositionsByInstanceId.get("e-1")
    expect([d?.state, d?.reason]).toEqual(["model_miss", "test_failed"])
    expect(d?.gradingValid).toBe(true)
    // recorded for the legacy `emptyPatch` bucket only — never for the state
    expect(d?.predictionEmpty).toBe(true)
  })

  test("emptiness NEVER overrides golden authority", () => {
    const text = officialDocument([
      officialRow({ instanceId: "e-1", golden: "apply_failed", model: "non zero exit" }),
    ])
    const r = buildProMaxOfficialGradeReceipt({
      assignedInstanceIds: ["e-1"],
      evaluator: evaluatorIdentity(),
      run: { exitCode: 0, stdout: "", stderr: "", outputJsonText: text, outputPath: OUTPUT_PATH },
      emptyPredictionInstanceIds: ["e-1"],
    })
    const d = okOf(r).dispositionsByInstanceId.get("e-1")
    expect([d?.state, d?.reason]).toEqual(["infra_invalid", "golden_apply_failed"])
  })
})
