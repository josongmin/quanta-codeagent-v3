import { describe, expect, test } from "bun:test"
import { normalizeProRow, parseSwebenchJsonl, toInstance } from "./dataset"

// Base fixture = a PYTHON Pro row, so the normalizer's load-bearing effect (lowercase
// f2p → real pytest testCmd) is observable. A non-Python row is tested separately
// (audit #7) since it short-circuits to the "true" no-op regardless of the normalizer.
const proRow = {
  instance_id: "scale__demo-1",
  repo: "demo/demo",
  base_commit: "0".repeat(40),
  problem_statement: "fix the bug",
  patch: "diff --git a b",
  fail_to_pass: JSON.stringify(["tests/test_x.py::test_y"]),
  pass_to_pass: JSON.stringify(["tests/test_x.py::test_z"]),
  dockerhub_tag: "demo-demo-1",
  repo_language: "python",
}

describe("Pro ingest — normalize + parse + carry (RFC jun-29)", () => {
  test("normalizeProRow maps lowercase f2p/p2p to UPPER; preserves extras + originals", () => {
    const n = normalizeProRow(proRow)
    expect(n.FAIL_TO_PASS).toEqual(proRow.fail_to_pass)
    expect(n.PASS_TO_PASS).toEqual(proRow.pass_to_pass)
    expect(n.fail_to_pass).toEqual(proRow.fail_to_pass) // original kept
    expect(n.dockerhub_tag).toBe("demo-demo-1")
  })

  test("normalizer does NOT clobber an already-UPPER key", () => {
    const n = normalizeProRow({ FAIL_TO_PASS: ["already"], fail_to_pass: ["lower"] })
    expect(n.FAIL_TO_PASS).toEqual(["already"])
  })

  test("parse(text, normalizeProRow) → toInstance derives a real testCmd + carries Pro meta", () => {
    const tasks = parseSwebenchJsonl(JSON.stringify(proRow), normalizeProRow)
    expect(tasks).toHaveLength(1)
    const inst = toInstance(tasks[0]!, "/tmp/repo")
    expect(inst.testCmd).not.toBe("true")
    expect(inst.testCmd).toContain("test_y")
    expect(inst.swebench?.dockerhubTag).toBe("demo-demo-1")
    expect(inst.swebench?.repoLanguage).toBe("python")
    expect(inst.swebench?.passToPass).toBeDefined()
  })

  // Paired control — proves the normalizer is LOAD-BEARING: an un-normalized PYTHON Pro
  // row (lowercase keys) yields the testCmd:"true" no-op (the fake-green risk). Python so
  // the ONLY reason for "true" is the missing FAIL_TO_PASS, not the repo_language gate.
  test("WITHOUT normalizer, lowercase Python Pro row ⇒ testCmd:'true' (normalizer is load-bearing)", () => {
    const tasks = parseSwebenchJsonl(JSON.stringify(proRow)) // default identity
    const inst = toInstance(tasks[0]!, "/tmp/repo")
    expect(inst.testCmd).toBe("true")
  })

  // audit #7: a non-Python Pro row (go/js/ts) must NOT synthesize a pytest testCmd — it's
  // a fake-grade vector. It returns the "true" no-op so verdict.ts's harness-required guard
  // fires instead of running pytest on a Go tree. Meta is still carried.
  test("non-Python repo_language (go) ⇒ testCmd 'true' (no pytest fake-grade) + meta carried", () => {
    const goRow = { ...proRow, repo_language: "go" }
    const tasks = parseSwebenchJsonl(JSON.stringify(goRow), normalizeProRow)
    const inst = toInstance(tasks[0]!, "/tmp/repo")
    expect(inst.testCmd).toBe("true")
    expect(inst.swebench?.repoLanguage).toBe("go")
    expect(inst.swebench?.dockerhubTag).toBe("demo-demo-1")
  })

  // audit EDGE-2: python SPELLINGS (python3 / py / cpython / "Python") must be treated as
  // python — NOT fenced to the "true" no-op (that would mute a gradeable Python repo).
  test("python spellings (python3/py/cpython/Python) ⇒ real testCmd, not fenced", () => {
    for (const repo_language of ["python3", "py", "cpython", "Python", "python 3.11"]) {
      const tasks = parseSwebenchJsonl(JSON.stringify({ ...proRow, repo_language }), normalizeProRow)
      const inst = toInstance(tasks[0]!, "/tmp/repo")
      expect(inst.testCmd).not.toBe("true")
      expect(inst.testCmd).toContain("test_y")
    }
  })

  // audit #8: a JSON null fail_to_pass must NOT be copied into FAIL_TO_PASS (it would
  // decode to the no-op silently); and it must never clobber an existing UPPER key.
  test("null fail_to_pass ⇒ not copied (no crash, no clobber)", () => {
    const n = normalizeProRow({ fail_to_pass: null, FAIL_TO_PASS: ["kept"] })
    expect(n.FAIL_TO_PASS).toEqual(["kept"])
    const n2 = normalizeProRow({ fail_to_pass: null })
    expect(n2.FAIL_TO_PASS).toBeUndefined()
  })

  test("Verified row (uppercase) unaffected by the optional param — no Pro fields leak", () => {
    const verifiedRow = {
      instance_id: "astropy__astropy-1",
      repo: "astropy/astropy",
      base_commit: "a".repeat(40),
      problem_statement: "fix",
      FAIL_TO_PASS: JSON.stringify(["tests/t.py::test_a"]),
    }
    const tasks = parseSwebenchJsonl(JSON.stringify(verifiedRow))
    const inst = toInstance(tasks[0]!, "/tmp/repo")
    expect(inst.testCmd).toContain("test_a")
    expect(inst.swebench?.dockerhubTag).toBeUndefined()
    expect(inst.swebench?.repoLanguage).toBeUndefined()
  })
})
