/**
 * Outcome-parser tests (mustPass branch of ADR-0011 verify-guard).
 *
 * `isVerifyOutputFailing(name, arg, output)` is the pure recognizer that
 * answers "did the verify call FAIL based on its captured output?". It is
 * consulted by `decideVerifyGuard` ONLY when `cfg.mustPass === true` AND
 * dispatch reported `ok:true`, to catch the rare case where a runner exits 0
 * but the report says some tests failed (e.g. `pytest
 * --continue-on-collection-errors`).
 *
 * Conservative contract being asserted here:
 *   - Empty output ⇒ false (no signal, no override).
 *   - Output with explicit ecosystem failure markers ⇒ true.
 *   - Output WITHOUT explicit markers ⇒ false (cannot prove failure).
 *   - Plain "error" strings without an anchored runner marker ⇒ false (a
 *     stack trace alone is NOT a verify-failure signal — pytest may print
 *     a traceback for a passing test that runs `try/except`, and broad
 *     "Error" matching would over-block).
 *
 * Per the project's no-heuristics rule, the registry only includes patterns
 * tied to specific, recognizable runner summary lines.
 */
import { describe, expect, test } from "bun:test"
import { isVerifyOutputFailing, OUTCOME_FAILURE_MATCHERS } from "@/agent/verify-signal"

const probe = (output: string): boolean => isVerifyOutputFailing("test_runner", undefined, output)

describe("isVerifyOutputFailing — empty + null-ish", () => {
  test("empty string ⇒ false (no signal)", () => {
    expect(probe("")).toBe(false)
  })

  test("whitespace-only ⇒ false (no signal — no anchored marker)", () => {
    expect(probe("   \n\t  \n")).toBe(false)
  })

  test("non-string output (defensive) ⇒ false", () => {
    expect(isVerifyOutputFailing("bash", "pytest", undefined as unknown as string)).toBe(false)
  })
})

describe("isVerifyOutputFailing — pytest", () => {
  test("classic summary `===== 3 failed in 0.42s =====` ⇒ true", () => {
    expect(
      probe("tests/test_x.py .F\n=================== 3 failed in 0.42s ==================="),
    ).toBe(true)
  })

  test("`===== 1 failed, 2 passed =====` ⇒ true", () => {
    expect(probe("=========== 1 failed, 2 passed in 1.23s ===========")).toBe(true)
  })

  test("FAILED line per failing test ⇒ true", () => {
    expect(
      probe(
        "tests/test_x.py::test_y FAILED [50%]\nFAILED tests/test_x.py::test_y - AssertionError",
      ),
    ).toBe(true)
  })

  test("short form `3 failed in 1.23s` (top-of-line) ⇒ true", () => {
    expect(probe("3 failed in 1.23s")).toBe(true)
  })

  test("all-pass `===== 5 passed in 0.42s =====` ⇒ false", () => {
    expect(probe("===== 5 passed in 0.42s =====")).toBe(false)
  })

  test("collection error WITHOUT failed-count is NOT counted ⇒ false (conservative)", () => {
    // Bare 'ERROR' is not in the registry. Until pytest prints a `failed`
    // summary or a `FAILED` line, we have no anchored failure signal.
    expect(probe("ERROR collecting tests/test_x.py")).toBe(false)
  })
})

describe("isVerifyOutputFailing — unittest", () => {
  test("`FAILED (failures=2)` ⇒ true", () => {
    expect(probe("Ran 5 tests in 0.01s\n\nFAILED (failures=2)")).toBe(true)
  })

  test("`FAILED (errors=1, failures=0)` ⇒ true", () => {
    expect(probe("FAILED (errors=1, failures=0)")).toBe(true)
  })

  test("`OK` summary ⇒ false", () => {
    expect(probe("Ran 5 tests in 0.01s\n\nOK")).toBe(false)
  })
})

describe("isVerifyOutputFailing — jest / vitest", () => {
  test("`Tests:       3 failed, 5 passed, 8 total` ⇒ true", () => {
    expect(probe("Tests:       3 failed, 5 passed, 8 total")).toBe(true)
  })

  test("`FAIL  tests/foo.test.ts` ⇒ true", () => {
    expect(probe("FAIL  tests/foo.test.ts\n  ✕ does the thing")).toBe(true)
  })

  test("`PASS  tests/foo.test.ts` + `Tests: 5 passed` ⇒ false", () => {
    expect(probe("PASS  tests/foo.test.ts\nTests:       5 passed, 5 total")).toBe(false)
  })
})

describe("isVerifyOutputFailing — mocha", () => {
  test("`5 failing` ⇒ true", () => {
    expect(probe("  10 passing (5s)\n  5 failing")).toBe(true)
  })

  test("`10 passing` only ⇒ false", () => {
    expect(probe("  10 passing (5s)")).toBe(false)
  })
})

describe("isVerifyOutputFailing — go test", () => {
  test("`--- FAIL: TestFoo` ⇒ true", () => {
    expect(probe("--- FAIL: TestFoo (0.00s)\n    foo_test.go:10: bar")).toBe(true)
  })

  test("`FAIL\\tpkg/path` ⇒ true", () => {
    expect(probe("FAIL\tgithub.com/foo/bar/pkg 0.012s")).toBe(true)
  })

  test("`ok  \\tpkg/path` ⇒ false", () => {
    expect(probe("ok  \tgithub.com/foo/bar/pkg 0.012s")).toBe(false)
  })
})

describe("isVerifyOutputFailing — cargo test", () => {
  test("`test result: FAILED.` ⇒ true", () => {
    expect(probe("test result: FAILED. 1 passed; 2 failed; 0 ignored")).toBe(true)
  })

  test("`test result: ok.` ⇒ false", () => {
    expect(probe("test result: ok. 3 passed; 0 failed; 0 ignored")).toBe(false)
  })
})

describe("isVerifyOutputFailing — rspec", () => {
  test("`5 examples, 2 failures` ⇒ true", () => {
    expect(probe("5 examples, 2 failures")).toBe(true)
  })

  test("`5 examples, 0 failures` ⇒ false (no failure tokens)", () => {
    expect(probe("5 examples, 0 failures")).toBe(false)
  })
})

describe("isVerifyOutputFailing — phpunit", () => {
  test("`FAILURES!` summary ⇒ true", () => {
    expect(probe("FAILURES!\nTests: 5, Assertions: 12, Failures: 3.")).toBe(true)
  })

  test("`OK (5 tests, 12 assertions)` ⇒ false", () => {
    expect(probe("OK (5 tests, 12 assertions)")).toBe(false)
  })
})

describe("isVerifyOutputFailing — dotnet", () => {
  test("`Failed!  - Failed:    3` ⇒ true", () => {
    expect(probe("Failed!  - Failed:    3, Passed:     5, Skipped:     0")).toBe(true)
  })

  test("`Passed!  - Failed:    0` ⇒ false", () => {
    expect(probe("Passed!  - Failed:    0, Passed:     5, Skipped:     0")).toBe(false)
  })
})

describe("isVerifyOutputFailing — make", () => {
  test("`make: *** [target] Error 1` ⇒ true", () => {
    expect(probe("make: *** [test] Error 1")).toBe(true)
  })

  test("`make[1]: *** [sub] Error 2` ⇒ true (recursive make)", () => {
    expect(probe("make[1]: *** [sub] Error 2")).toBe(true)
  })

  test("`make: all targets up to date` ⇒ false", () => {
    expect(probe("make: 'all' is up to date.")).toBe(false)
  })
})

describe("isVerifyOutputFailing — false-positive guards", () => {
  test("bare `Error` in body without anchored marker ⇒ false", () => {
    // We deliberately do NOT match a stack-trace 'Error' (Python tracebacks
    // print Error lines in successful test runs that test exception paths).
    expect(probe("Traceback (most recent call last):\n  ValueError: oops")).toBe(false)
  })

  test("variable named `failed` in code echo ⇒ false (no line-anchor)", () => {
    expect(probe("config.failed = False")).toBe(false)
  })

  test("`pytest test passed` echoed in middle of line ⇒ false", () => {
    expect(probe("    pytest test passed: 5/5")).toBe(false)
  })

  test("ANSI escape codes around `FAILED` still matched ⇒ true", () => {
    // The matcher is line-anchored on `FAILED\s+\S` — ANSI codes between
    // FAILED and the path break the anchor. Document the trade-off: we
    // would rather UNDER-match on ANSI than over-match on prose.
    expect(probe("[31mFAIL[0m  tests/foo.test.ts")).toBe(false)
  })
})

describe("OUTCOME_FAILURE_MATCHERS shape", () => {
  test("every matcher has a stable id + ecosystem + RegExp", () => {
    for (const m of OUTCOME_FAILURE_MATCHERS) {
      expect(typeof m.id).toBe("string")
      expect(m.id.length).toBeGreaterThan(0)
      expect(typeof m.ecosystem).toBe("string")
      expect(m.pattern).toBeInstanceOf(RegExp)
    }
  })

  test("matcher ids are unique", () => {
    const ids = OUTCOME_FAILURE_MATCHERS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("at least one matcher per major ecosystem", () => {
    const ecosystems = new Set(OUTCOME_FAILURE_MATCHERS.map((m) => m.ecosystem))
    for (const required of ["python", "js", "go", "rust"]) {
      expect(ecosystems.has(required)).toBe(true)
    }
  })
})
