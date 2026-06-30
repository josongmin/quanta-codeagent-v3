import { describe, expect, test } from "bun:test"
import { redactReviewerEvidence } from "./reviewer-evidence-redact"

describe("redactReviewerEvidence — no-leak + bound", () => {
  test("empty / whitespace-only ⇒ empty string", () => {
    expect(redactReviewerEvidence("", 1000)).toBe("")
    expect(redactReviewerEvidence("   \n  \t\n", 1000)).toBe("")
    // non-string defensive
    expect(redactReviewerEvidence(undefined as unknown as string, 1000)).toBe("")
  })

  test("ordinary pytest stderr is PRESERVED (this is the discriminating signal)", () => {
    const raw = [
      "____ test_thing ____",
      "    def test_thing():",
      ">       assert compute(2) == 4",
      "E       assert 3 == 4",
      "E        +  where 3 = compute(2)",
      "tests/test_thing.py:12: AssertionError",
      "===== 1 failed in 0.04s =====",
    ].join("\n")
    const out = redactReviewerEvidence(raw, 5000)
    expect(out).toContain("assert compute(2) == 4")
    expect(out).toContain("AssertionError")
    expect(out).toContain("1 failed")
  })

  test("strips a unified-diff block but keeps surrounding prose", () => {
    const raw = [
      "Traceback shows the fix would be:",
      "diff --git a/pkg/mod.py b/pkg/mod.py",
      "index 1111111..2222222 100644",
      "--- a/pkg/mod.py",
      "+++ b/pkg/mod.py",
      "@@ -10,7 +10,7 @@ def f(x):",
      "-    return x + 1",
      "+    return x + 2",
      "     return x",
      "End of output, test still failing.",
    ].join("\n")
    const out = redactReviewerEvidence(raw, 5000)
    expect(out).toContain("Traceback shows the fix would be:")
    expect(out).toContain("End of output, test still failing.")
    // the answer-patch shape is gone
    expect(out).not.toContain("diff --git")
    expect(out).not.toContain("+++ b/pkg/mod.py")
    expect(out).not.toContain("@@ -10,7 +10,7 @@")
    expect(out).not.toContain("return x + 2")
    expect(out).not.toContain("return x + 1")
  })

  test("strips multiple diff blocks interleaved with prose", () => {
    const raw = [
      "first",
      "diff --git a/x b/x",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "middle prose",
      "diff --git a/y b/y",
      "@@ -2 +2 @@",
      "+addy",
      "last",
    ].join("\n")
    const out = redactReviewerEvidence(raw, 5000)
    expect(out).toContain("first")
    expect(out).toContain("middle prose")
    expect(out).toContain("last")
    expect(out).not.toContain("diff --git")
    expect(out).not.toContain("+new")
    expect(out).not.toContain("+addy")
  })

  test("strips answer-key marker lines (hidden-field names / gold patch)", () => {
    const raw = [
      "running tests",
      "FAIL_TO_PASS: [test_a, test_b]",
      "PASS_TO_PASS: [test_c]",
      "test_patch applied",
      "gold patch: a/b.py",
      "1 failed",
    ].join("\n")
    const out = redactReviewerEvidence(raw, 5000)
    expect(out).toContain("running tests")
    expect(out).toContain("1 failed")
    expect(out).not.toContain("FAIL_TO_PASS")
    expect(out).not.toContain("PASS_TO_PASS")
    expect(out).not.toContain("test_patch")
    expect(out).not.toContain("gold patch")
  })

  test("a line merely CONTAINING 'expected' survives (anchored, conservative)", () => {
    const raw = "AssertionError: expected 4 but got 3"
    expect(redactReviewerEvidence(raw, 5000)).toContain("expected 4 but got 3")
  })

  test("bounds length tail-first with a truncation marker", () => {
    const raw = `HEAD_NOISE\n${"x".repeat(2000)}\nTAIL_ASSERTION_ERROR`
    const out = redactReviewerEvidence(raw, 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).toContain("TAIL_ASSERTION_ERROR")
    expect(out).toContain("(truncated)")
    expect(out).not.toContain("HEAD_NOISE")
  })

  test("maxChars <= 0 ⇒ empty", () => {
    expect(redactReviewerEvidence("some output here", 0)).toBe("")
    expect(redactReviewerEvidence("some output here", -5)).toBe("")
  })

  test("output that is ONLY a diff block ⇒ empty (nothing safe remains)", () => {
    const raw = ["diff --git a/x b/x", "@@ -1 +1 @@", "-a", "+b"].join("\n")
    expect(redactReviewerEvidence(raw, 5000)).toBe("")
  })
})
