/**
 * Epic-2 — test-output parsers (pure core). Fixtures are VERBATIM real output
 * captured 2026-06-10 from go test -json / cargo test / python -m unittest, so
 * the parsers are pinned to reality (not guessed). Each → normalized
 * {passed, failed:[{name,file,line,message}]}.
 */
import { describe, expect, test } from "bun:test"
import { parseCargo, parseGoJson, parsePythonUnittest } from "@/tool/testrun/parse"

const GO_JSON = [
  '{"Action":"run","Package":"t","Test":"TestPass"}',
  '{"Action":"output","Package":"t","Test":"TestPass","Output":"--- PASS: TestPass (0.00s)\\n"}',
  '{"Action":"pass","Package":"t","Test":"TestPass","Elapsed":0}',
  '{"Action":"run","Package":"t","Test":"TestFail"}',
  '{"Action":"output","Package":"t","Test":"TestFail","Output":"    m_test.go:4: got 4 want 5\\n"}',
  '{"Action":"output","Package":"t","Test":"TestFail","Output":"--- FAIL: TestFail (0.00s)\\n"}',
  '{"Action":"fail","Package":"t","Test":"TestFail","Elapsed":0}',
  '{"Action":"fail","Package":"t","Elapsed":0.333}',
].join("\n")

const CARGO_TEXT = [
  "running 2 tests",
  "test tests::pass_test ... ok",
  "test tests::fail_test ... FAILED",
  "",
  "failures:",
  "",
  "---- tests::fail_test stdout ----",
  "",
  "thread 'tests::fail_test' (50375128) panicked at src/lib.rs:6:30:",
  "assertion `left == right` failed",
  "  left: 4",
  " right: 5",
  "",
  "failures:",
  "    tests::fail_test",
  "",
  "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
].join("\n")

const PY_UNITTEST = [
  "test_fail (test_m.T) ... FAIL",
  "test_pass (test_m.T) ... ok",
  "",
  "======================================================================",
  "FAIL: test_fail (test_m.T)",
  "----------------------------------------------------------------------",
  "Traceback (most recent call last):",
  '  File "/private/tmp/tr/py/test_m.py", line 4, in test_fail',
  "    def test_fail(self): self.assertEqual(2+2, 5)",
  "AssertionError: 4 != 5",
  "",
  "----------------------------------------------------------------------",
  "Ran 2 tests in 0.000s",
  "",
  "FAILED (failures=1)",
].join("\n")

describe("parseGoJson", () => {
  test("counts passes and extracts failing test with file:line + message", () => {
    const r = parseGoJson(GO_JSON)
    expect(r.passed).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.name).toBe("TestFail")
    expect(r.failed[0]!.file).toBe("m_test.go")
    expect(r.failed[0]!.line).toBe(4)
    expect(r.failed[0]!.message).toContain("got 4 want 5")
    expect(r.ok).toBe(false)
  })

  test("all-pass ⇒ ok true, no failures", () => {
    const r = parseGoJson(['{"Action":"pass","Test":"A"}', '{"Action":"pass","Test":"B"}'].join("\n"))
    expect(r.passed).toBe(2)
    expect(r.failed).toHaveLength(0)
    expect(r.ok).toBe(true)
  })

  test("malformed JSON lines are skipped, never throws", () => {
    expect(() => parseGoJson("not json\n{bad\n")).not.toThrow()
  })

  test("BUILD FAILURE (compile error) ⇒ a synthesized failure, NOT a false green", () => {
    const buildFail = [
      '{"ImportPath":"t [t.test]","Action":"build-output","Output":"./x_test.go:3:27: undefined: foo\\n"}',
      '{"ImportPath":"t [t.test]","Action":"build-fail"}',
      '{"Action":"fail","Package":"t","FailedBuild":"t [t.test]"}',
    ].join("\n")
    const r = parseGoJson(buildFail)
    expect(r.ok).toBe(false)
    expect(r.failed.length).toBeGreaterThan(0)
    expect(r.failed[0]!.message ?? "").toContain("undefined: foo")
  })

  test("duplicate fail events for one test are de-duplicated", () => {
    const r = parseGoJson(['{"Action":"fail","Test":"T"}', '{"Action":"fail","Test":"T"}'].join("\n"))
    expect(r.failed).toHaveLength(1)
  })
})

describe("parseCargo", () => {
  test("extracts failing test name + panic file:line + assertion message; passed count", () => {
    const r = parseCargo(CARGO_TEXT)
    expect(r.passed).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.name).toBe("tests::fail_test")
    expect(r.failed[0]!.file).toBe("src/lib.rs")
    expect(r.failed[0]!.line).toBe(6)
    expect(r.failed[0]!.message).toContain("left == right")
    expect(r.ok).toBe(false)
  })

  test("all-pass summary ⇒ ok true", () => {
    const r = parseCargo("test tests::a ... ok\ntest result: ok. 1 passed; 0 failed; finished in 0.00s")
    expect(r.ok).toBe(true)
    expect(r.failed).toHaveLength(0)
  })

  test("multiple sections (lib + doctests) ⇒ passed counts are SUMMED, not overwritten", () => {
    const r = parseCargo(
      [
        "test result: ok. 5 passed; 0 failed; finished in 0.01s",
        "   Doc-tests t",
        "test result: ok. 1 passed; 0 failed; finished in 0.02s",
      ].join("\n"),
    )
    expect(r.passed).toBe(6) // 5 + 1, not 1
    expect(r.ok).toBe(true)
  })

  test("multi-line panic message keeps the assertion detail", () => {
    const r = parseCargo(CARGO_TEXT)
    expect(r.failed[0]!.message).toContain("left: 4")
    expect(r.failed[0]!.message).toContain("right: 5")
  })
})

describe("parsePythonUnittest", () => {
  test("extracts failing test + file:line + message; passed count", () => {
    const r = parsePythonUnittest(PY_UNITTEST)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.name).toContain("test_fail")
    expect(r.failed[0]!.file).toContain("test_m.py")
    expect(r.failed[0]!.line).toBe(4)
    expect(r.failed[0]!.message).toContain("AssertionError: 4 != 5")
    expect(r.passed).toBe(1) // 2 ran, 1 failed
    expect(r.ok).toBe(false)
  })

  test("OK run ⇒ ok true", () => {
    const r = parsePythonUnittest("test_a (m.T) ... ok\n\nRan 1 test in 0.0s\n\nOK")
    expect(r.ok).toBe(true)
    expect(r.failed).toHaveLength(0)
  })
})
