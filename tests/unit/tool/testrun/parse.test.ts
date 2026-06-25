/**
 * Epic-2 — test-output parsers (pure core). Fixtures are VERBATIM real output
 * captured 2026-06-10 from go test -json / cargo test / python -m unittest, so
 * the parsers are pinned to reality (not guessed). Each → normalized
 * {passed, failed:[{name,file,line,message}]}.
 */
import { describe, expect, test } from "bun:test"
import {
  parseCargo,
  parseCtest,
  parseGoJson,
  parsePytest,
  parsePythonUnittest,
} from "@/tool/testrun/parse"

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
    const r = parseGoJson(
      ['{"Action":"pass","Test":"A"}', '{"Action":"pass","Test":"B"}'].join("\n"),
    )
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
    const r = parseGoJson(
      ['{"Action":"fail","Test":"T"}', '{"Action":"fail","Test":"T"}'].join("\n"),
    )
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
    const r = parseCargo(
      "test tests::a ... ok\ntest result: ok. 1 passed; 0 failed; finished in 0.00s",
    )
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

// VERBATIM pytest 9.0.3 output (captured 2026-06-10 via a venv): a FAILURES
// section (one `___ test ___` block per failure, ending `FILE:LINE: ExcType`) +
// a short-summary `FAILED FILE::test - msg` list + an `N failed, M passed` total.
const PYTEST = [
  "F.F                                                                      [100%]",
  "=================================== FAILURES ===================================",
  "___________________________________ test_add ___________________________________",
  "",
  "    def test_add():",
  ">       assert add(2, 2) == 5",
  "E       assert 4 == 5",
  "E        +  where 4 = add(2, 2)",
  "",
  "test_math.py:5: AssertionError",
  "____________________________ TestThings.test_method ____________________________",
  "",
  "self = <test_math.TestThings object at 0x107ef3d90>",
  "",
  "    def test_method(self):",
  ">       assert add(0, 0) == 9",
  "E       assert 0 == 9",
  "E        +  where 0 = add(0, 0)",
  "",
  "test_math.py:12: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED test_math.py::test_add - assert 4 == 5",
  "FAILED test_math.py::TestThings::test_method - assert 0 == 9",
  "2 failed, 1 passed in 0.01s",
].join("\n")

describe("parsePytest", () => {
  test("localizes each failure to {file,line} via the FAILURES block + summary msg", () => {
    const r = parsePytest(PYTEST)
    expect(r.runner).toBe("pytest")
    expect(r.ok).toBe(false)
    expect(r.passed).toBe(1)
    expect(r.failed).toHaveLength(2)
    // Zipped per-block location onto the summary entry (same order).
    expect(r.failed[0]).toEqual({
      name: "test_add",
      file: "test_math.py",
      line: 5,
      message: "assert 4 == 5",
    })
    expect(r.failed[1]).toEqual({
      name: "TestThings::test_method",
      file: "test_math.py",
      line: 12,
      message: "assert 0 == 9",
    })
  })

  test("green run ⇒ no failures", () => {
    const r = parsePytest("..                                  [100%]\n\n2 passed in 0.01s")
    expect(r.ok).toBe(true)
    expect(r.passed).toBe(2)
    expect(r.failed).toHaveLength(0)
  })

  test("collection ERROR (e.g. import/syntax) is surfaced as a failure", () => {
    const out = [
      "==================================== ERRORS ====================================",
      "_____________________ ERROR collecting test_bad.py _____________________",
      "test_bad.py:1: in <module>",
      "    import nope",
      "E   ModuleNotFoundError: No module named 'nope'",
      "=========================== short test summary info ============================",
      "ERROR test_bad.py - ModuleNotFoundError: No module named 'nope'",
      "1 error in 0.02s",
    ].join("\n")
    const r = parsePytest(out)
    expect(r.ok).toBe(false)
    expect(r.failed[0]?.name).toBe("test_bad.py") // no `::test` ⇒ the file is the id
    expect(r.failed[0]?.message).toContain("ModuleNotFoundError")
  })

  test("NEVER-throws on garbage", () => {
    expect(() => parsePytest("¬ nonsense ½")).not.toThrow()
  })
})

describe("parseCtest (C++)", () => {
  test("libc assert (VERBATIM): localizes file+line+function+message", () => {
    // Captured 2026-06-10 from a real `clang++ -g` build's assert abort.
    const out = "Assertion failed: (result == 99), function main, file t.cpp, line 5."
    const r = parseCtest(out)
    expect(r.runner).toBe("ctest")
    expect(r.ok).toBe(false)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toEqual({
      name: "main",
      file: "t.cpp",
      line: 5,
      message: "Assertion failed: (result == 99)",
    })
  })

  test("GoogleTest (VERBATIM, gtest 1.17.0): one failure, NOT the summary lines", () => {
    // Captured 2026-06-10 from a real `clang++ + libgtest` build. The trailing
    // summary block has TWO extra `[ FAILED ]` lines (`1 test, listed below:` +
    // a bare `MathTest.Adds`) — neither has `(N ms)`, so both are excluded.
    const out = [
      "[==========] Running 1 test from 1 test suite.",
      "[----------] 1 test from MathTest",
      "[ RUN      ] MathTest.Adds",
      "math_test.cpp:5: Failure",
      "Expected equality of these values:",
      "  result",
      "    Which is: 10",
      "  99",
      "",
      "[  FAILED  ] MathTest.Adds (0 ms)",
      "[----------] 1 test from MathTest (0 ms total)",
      "[  PASSED  ] 0 tests.",
      "[  FAILED  ] 1 test, listed below:",
      "[  FAILED  ] MathTest.Adds",
      "",
      " 1 FAILED TEST",
    ].join("\n")
    const r = parseCtest(out)
    expect(r.passed).toBe(0)
    expect(r.failed).toHaveLength(1) // NOT 3 — summary lines excluded (the bug verbatim caught)
    expect(r.failed[0]?.name).toBe("MathTest.Adds")
    expect(r.failed[0]?.file).toBe("math_test.cpp")
    expect(r.failed[0]?.line).toBe(5)
  })

  test("GoogleTest TWO failures, first with TWO assertions: each name keeps ITS OWN first location", () => {
    // The OLD 3-independent-scan zip mis-pairs: `Adds` has two `Failure` lines,
    // so `locs` has 3 entries for 2 names ⇒ `Subs` inherits `add.cpp:9` (the
    // SECOND assertion of `Adds`) instead of its own `sub.cpp:3`.
    const out = [
      "[ RUN      ] MathTest.Adds",
      "add.cpp:5: Failure",
      "Expected equality of these values:",
      "  1",
      "add.cpp:9: Failure",
      "Expected equality of these values:",
      "  2",
      "[  FAILED  ] MathTest.Adds (0 ms)",
      "[ RUN      ] MathTest.Subs",
      "sub.cpp:3: Failure",
      "Expected equality of these values:",
      "  7",
      "[  FAILED  ] MathTest.Subs (0 ms)",
      "[  PASSED  ] 0 tests.",
      "[  FAILED  ] 2 tests, listed below:",
      "[  FAILED  ] MathTest.Adds",
      "[  FAILED  ] MathTest.Subs",
    ].join("\n")
    const r = parseCtest(out)
    expect(r.failed).toHaveLength(2)
    const adds = r.failed.find((f) => f.name === "MathTest.Adds")
    const subs = r.failed.find((f) => f.name === "MathTest.Subs")
    expect(adds?.file).toBe("add.cpp")
    expect(adds?.line).toBe(5) // first assertion of Adds
    expect(subs?.file).toBe("sub.cpp") // NOT add.cpp (the old-zip bug)
    expect(subs?.line).toBe(3)
  })

  test("green run ⇒ no failures; NEVER-throws on garbage", () => {
    expect(parseCtest("[  PASSED  ] 3 tests.").ok).toBe(true)
    expect(() => parseCtest("¬ noise")).not.toThrow()
  })
})
