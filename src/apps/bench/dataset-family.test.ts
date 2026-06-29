import { describe, expect, test } from "bun:test"
import { toInstance } from "@/runner/batch/corpus/dataset"
import {
  gradeEvaluatorForFamily,
  parseTasksForFamily,
  resolveDatasetFamily,
} from "./dataset-family"
import type { Instance } from "./types"

describe("resolveDatasetFamily", () => {
  test("argv wins, then env, default verified", () => {
    expect(resolveDatasetFamily("pro", {})).toBe("pro")
    expect(resolveDatasetFamily(undefined, { QUANTA_SWEBENCH_DATASET_FAMILY: "live" })).toBe("live")
    expect(resolveDatasetFamily(undefined, {})).toBe("verified")
  })
  test("unknown ⇒ verified (fail-safe to the byte-identical default)", () => {
    expect(resolveDatasetFamily("bogus", {})).toBe("verified")
    expect(resolveDatasetFamily("PRO", {})).toBe("pro") // case-insensitive
  })
})

describe("parseTasksForFamily — Pro normalizes, verified does not (de-theaters normalizeProRow)", () => {
  const proRow = JSON.stringify({
    instance_id: "scale__demo-1",
    repo: "demo/demo",
    base_commit: "0".repeat(40),
    problem_statement: "x",
    fail_to_pass: JSON.stringify(["tests/t.py::test_y"]),
    repo_language: "python",
  })
  test("family=pro ⇒ lowercase fail_to_pass becomes a real testCmd", () => {
    const t = parseTasksForFamily(proRow, "pro")
    expect(toInstance(t[0]!, "/tmp").testCmd).toContain("test_y")
  })
  test("family=verified ⇒ same lowercase row degrades to the no-op (no normalize)", () => {
    const t = parseTasksForFamily(proRow, "verified")
    expect(toInstance(t[0]!, "/tmp").testCmd).toBe("true")
  })
})

describe("gradeEvaluatorForFamily — routes to the right verifier (de-theaters the Pro verifier)", () => {
  const inst: Instance = {
    id: "scale__demo-1",
    repoPath: "/tmp",
    problemStatement: "x",
    testCmd: "true",
    swebench: { instanceId: "scale__demo-1", repo: "demo/demo", baseCommit: "0".repeat(40) },
  }
  test("family=pro routes to the Pro verifier (fail-closed 'not wired' when harness opts absent)", async () => {
    const r = await gradeEvaluatorForFamily("pro", {})(inst, "diff --git a b")
    expect(r.log).toContain("Pro harness not wired") // proves it reached evaluateWithProSwebench
    expect(r.resolved).toBe(false)
    expect(r.gradingCompleted).toBe(false)
  })
  test("family=verified routes to the official verifier (NOT the Pro path)", async () => {
    // inject a probe=false so the official path returns 'unavailable' hermetically (no real
    // `import swebench` spawn). The point is only that it is NOT the Pro verifier.
    const r = await gradeEvaluatorForFamily("verified")(inst, "diff --git a b", {
      probe: async () => false,
    })
    expect(r.log).not.toContain("Pro harness not wired")
  })
})
