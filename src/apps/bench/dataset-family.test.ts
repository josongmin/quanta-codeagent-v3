import { describe, expect, test } from "bun:test"
import { toInstance } from "@/runner/batch/corpus/dataset"
import {
  bridgeDatasetFamilyToEnv,
  gradeEvaluatorForFamily,
  parseTasksForFamily,
  resolveDatasetFamily,
} from "./dataset-family"
import { localLiveGradeRefusal } from "./python-swebench"
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

describe("bridgeDatasetFamilyToEnv — flag → canonical env (A1: full-remote/pool footgun fix)", () => {
  test("--dataset-family live writes canonical env (so box-forward + pre-flight see it)", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(bridgeDatasetFamilyToEnv("live", env)).toBe("live")
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("live")
  })
  test("flag BEATS a stale env (the exact footgun: flag was ignored before)", () => {
    const env: NodeJS.ProcessEnv = { QUANTA_SWEBENCH_DATASET_FAMILY: "verified" }
    expect(bridgeDatasetFamilyToEnv("live", env)).toBe("live")
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("live")
  })
  test("no flag ⇒ NO write (env/default untouched ⇒ byte-identical)", () => {
    const env: NodeJS.ProcessEnv = { QUANTA_SWEBENCH_DATASET_FAMILY: "pro" }
    expect(bridgeDatasetFamilyToEnv(undefined, env)).toBe("pro")
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("pro")
  })
  test("empty flag ⇒ NO write (treated as absent)", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(bridgeDatasetFamilyToEnv("", env)).toBe("verified")
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBeUndefined()
  })
  test("unknown flag ⇒ verified fail-safe, written canonical", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(bridgeDatasetFamilyToEnv("bogus", env)).toBe("verified")
    expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe("verified")
  })
})

describe("localLiveGradeRefusal — guard unconfigured LOCAL Live grade (A2), box-safe", () => {
  test("live + no namespace ⇒ REFUSE with actionable guidance", () => {
    const r = localLiveGradeRefusal("live", undefined)
    expect(r).toBeDefined()
    expect(r).toContain("--backend")
    expect(r).toContain("starryzhang")
  })
  test("live + blank namespace ⇒ refuse (treated as unset)", () => {
    expect(localLiveGradeRefusal("live", "   ")).toBeDefined()
  })
  test("BOX-SAFE: live + starryzhang namespace ⇒ proceed (undefined)", () => {
    expect(localLiveGradeRefusal("live", "starryzhang")).toBeUndefined()
  })
  test("verified / pro ⇒ never refuse (not live)", () => {
    expect(localLiveGradeRefusal("verified", undefined)).toBeUndefined()
    expect(localLiveGradeRefusal("pro", undefined)).toBeUndefined()
  })
})

describe("parseTasksForFamily — live uses the standard (verified-identical) parse", () => {
  // A representative SWE-bench-Live row: snake_case core fields + UPPERCASE
  // FAIL_TO_PASS/PASS_TO_PASS — the SAME schema as Verified. Pins the assumption
  // (flagged untested by the family-coverage audit) that Live's JSONL parses with
  // the standard schema, so a Live row yields a REAL testCmd (not the "true" no-op).
  const liveRow = JSON.stringify({
    instance_id: "getmoto__moto-7141",
    repo: "getmoto/moto",
    base_commit: "a".repeat(40),
    problem_statement: "live issue text",
    FAIL_TO_PASS: JSON.stringify(["tests/test_s3.py::test_live_thing"]),
    PASS_TO_PASS: JSON.stringify([]),
  })
  test("family=live ⇒ core fields carry through + uppercase FAIL_TO_PASS yields a real testCmd", () => {
    const inst = toInstance(parseTasksForFamily(liveRow, "live")[0]!, "/tmp")
    expect(inst.swebench?.instanceId).toBe("getmoto__moto-7141")
    expect(inst.swebench?.repo).toBe("getmoto/moto")
    expect(inst.swebench?.baseCommit).toBe("a".repeat(40))
    expect(inst.testCmd).toContain("test_live_thing") // NOT the "true" no-op
  })
  test("live parse === verified parse for the same standard row (no Pro normalization)", () => {
    expect(parseTasksForFamily(liveRow, "live")).toEqual(parseTasksForFamily(liveRow, "verified"))
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
