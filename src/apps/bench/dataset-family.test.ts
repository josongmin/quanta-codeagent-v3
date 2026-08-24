import { describe, expect, test } from "bun:test"
import { nth } from "../../../tests/_helpers/expect-present"
import { gradeEvaluatorForFamily, resolveDatasetFamily } from "./dataset-family"
import type { DatasetFamily } from "./dataset-family-token"
import { readFamilyCorpusText } from "./profiles/corpus-read"
import { runnableTasksOf } from "./profiles/corpus-row"
import type { Instance } from "./types"

// PMX-02: `parseTasksForFamily` is retired. The corpus parse now has ONE owner —
// `DatasetFamilyProfile.readCorpus`, reached via `readFamilyCorpusText` — and the
// runner `Instance` is built by the family's own closure. These cases still
// observe the SAME end effect they always did (the synthesized testCmd), just
// through the real production seam instead of the old shim.
const instancesFor = (text: string, family: DatasetFamily): Instance[] =>
  runnableTasksOf(readFamilyCorpusText(text, family)).map((row) => row.task.toInstance("/tmp"))

describe("resolveDatasetFamily", () => {
  test("argv wins, then env, default verified", () => {
    expect(resolveDatasetFamily("pro", {})).toBe("pro")
    expect(resolveDatasetFamily(undefined, { QUANTA_SWEBENCH_DATASET_FAMILY: "live" })).toBe("live")
    expect(resolveDatasetFamily(undefined, {})).toBe("verified")
  })
  // NOTE (jun-30 T2): `resolveDatasetFamily` stays LENIENT (unknown → verified) —
  // it is the internal helper used DOWNSTREAM of an already-validated config, so
  // its byte-identical absent-default contract is preserved. The FAIL-CLOSED split
  // (explicit-unknown → THROW vs absent → verified) lives at the composition-root
  // resolver `resolveBenchRunConfig` in `./run-config` (see run-config.test.ts).
  test("unknown ⇒ verified (lenient internal helper; fail-closed is in run-config)", () => {
    expect(resolveDatasetFamily("bogus", {})).toBe("verified")
    expect(resolveDatasetFamily("PRO", {})).toBe("pro") // case-insensitive
  })
})

describe("corpus parse — Pro normalizes, verified does not (de-theaters normalizeProRow)", () => {
  const proRow = JSON.stringify({
    instance_id: "scale__demo-1",
    repo: "demo/demo",
    base_commit: "0".repeat(40),
    problem_statement: "x",
    fail_to_pass: JSON.stringify(["tests/t.py::test_y"]),
    repo_language: "python",
  })
  test("family=pro ⇒ lowercase fail_to_pass becomes a real testCmd", () => {
    expect(nth(instancesFor(proRow, "pro"), 0, "pro instances").testCmd).toContain("test_y")
  })
  test("family=verified ⇒ same lowercase row degrades to the no-op (no normalize)", () => {
    expect(nth(instancesFor(proRow, "verified"), 0, "verified instances").testCmd).toBe("true")
  })
})

describe("corpus parse — live uses the standard (verified-identical) parse", () => {
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
    const inst = nth(instancesFor(liveRow, "live"), 0, "live instances")
    expect(inst.swebench?.instanceId).toBe("getmoto__moto-7141")
    expect(inst.swebench?.repo).toBe("getmoto/moto")
    expect(inst.swebench?.baseCommit).toBe("a".repeat(40))
    expect(inst.testCmd).toContain("test_live_thing") // NOT the "true" no-op
  })
  test("live parse === verified parse for the same standard row (no Pro normalization)", () => {
    expect(instancesFor(liveRow, "live")).toEqual(instancesFor(liveRow, "verified"))
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
