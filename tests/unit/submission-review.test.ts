/**
 * Strategy tool #6 — submission review verdict. Hard scenarios:
 *  - clean (source-only) / empty (no files) / test-edits (gaming) classification
 *  - reuses the isTestFilePath SSOT (tests/ dir, test_*.py, *_test, conftest)
 *  - mixed source+test ⇒ test-edits (the gaming flag dominates)
 *  - whitespace/empty diff ⇒ empty
 */

import { describe, expect, test } from "bun:test"
import { reviewSubmission } from "../../src/runner/batch/eval/submission-review"

const diff = (...files: string[]): string =>
  files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y`).join("\n")

describe("reviewSubmission", () => {
  test("source-only ⇒ clean", () => {
    const r = reviewSubmission(diff("src/core.py", "pkg/util.py"))
    expect(r.verdict).toBe("clean")
    expect(r.isSourceOnly).toBe(true)
    expect(r.testFilesTouched).toEqual([])
    expect(r.sourceFilesTouched).toEqual(["src/core.py", "pkg/util.py"])
  })

  test("touches a test file ⇒ test-edits (gaming flag), even alongside source edits", () => {
    const r = reviewSubmission(diff("src/core.py", "tests/test_core.py"))
    expect(r.verdict).toBe("test-edits")
    expect(r.isSourceOnly).toBe(false)
    expect(r.testFilesTouched).toEqual(["tests/test_core.py"])
    expect(r.sourceFilesTouched).toEqual(["src/core.py"])
  })

  test("recognizes the isTestFilePath SSOT shapes (test_*, *_test, conftest, tests/ dir)", () => {
    expect(reviewSubmission(diff("a/test_thing.py")).verdict).toBe("test-edits")
    expect(reviewSubmission(diff("a/thing_test.py")).verdict).toBe("test-edits")
    expect(reviewSubmission(diff("a/conftest.py")).verdict).toBe("test-edits")
    expect(reviewSubmission(diff("tests/sub/helper.py")).verdict).toBe("test-edits")
  })

  test("empty / whitespace diff ⇒ empty (a non-submission)", () => {
    expect(reviewSubmission("").verdict).toBe("empty")
    expect(reviewSubmission("   \n  ").verdict).toBe("empty")
    expect(reviewSubmission("").isEmpty).toBe(true)
    expect(reviewSubmission("").isSourceOnly).toBe(false) // empty is NOT source-only
  })
})
