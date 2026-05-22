import { describe, expect, test } from "bun:test"
import { buildRepairContext } from "../../src/apps/bench/eval/repair/context"

const SMALL_PROBLEM = "Fix the `foo()` function so that `foo(0)` returns 1 instead of 0."

describe("buildRepairContext (pure repair seed builder)", () => {
  test("round number appears in the first line", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "",
      round: 3,
    })
    expect(out.split("\n")[0]).toBe("Repair round 3.")
  })

  test("small problem statement preserved verbatim", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "",
      round: 1,
    })
    expect(out.includes(SMALL_PROBLEM)).toBe(true)
  })

  test("output is ≤ default maxBytes (12000)", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "",
      round: 1,
    })
    expect(out.length).toBeLessThanOrEqual(12000)
  })

  test("forceful next-step instructions present (no revert / fix source / re-verify)", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "",
      round: 1,
    })
    // Don't bind to exact phrasing, only to the non-negotiable substance.
    expect(out.includes("git checkout")).toBe(true)
    expect(out.includes("rerun") || out.includes("re-run") || out.includes("Re-run")).toBe(true)
  })

  test("output respects custom maxBytes", () => {
    const huge = "X".repeat(50_000)
    const out = buildRepairContext({
      problem: huge,
      cumulativeDiff: huge,
      failTail: huge,
      round: 2,
      maxBytes: 4096,
    })
    expect(out.length).toBeLessThanOrEqual(4096)
  })

  test("failTail kept as TAIL when truncated, with truncation marker", () => {
    const failTail = `${"H".repeat(8000)}${"T".repeat(1000)}`
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail,
      round: 1,
      maxBytes: 4000,
    })
    // The TAIL (the "T"s) must be present.
    expect(out.includes("T".repeat(500))).toBe(true)
    // The HEAD of failTail must NOT all survive (truncation kept the tail).
    // 8000 H's prefix → at least some must have been dropped given a 4000-byte
    // total budget.
    expect(out.includes("H".repeat(8000))).toBe(false)
    // Truncation marker present.
    expect(/<\d+ bytes truncated>/.test(out)).toBe(true)
    expect(out.length).toBeLessThanOrEqual(4000)
  })

  test("diff truncation: drops middle hunks, keeps `diff --git` headers + first+last hunks", () => {
    const head =
      "diff --git a/src/foo.py b/src/foo.py\nindex aaa..bbb 100644\n--- a/src/foo.py\n+++ b/src/foo.py\n"
    const hunk = (n: number) =>
      `@@ -${n},3 +${n},3 @@\n-${"old".repeat(50)}\n+${"new".repeat(50)}\n ${"ctx".repeat(50)}\n`
    // 8 hunks → enough to force middle drop.
    const hunks = [1, 100, 200, 300, 400, 500, 600, 700].map(hunk).join("")
    const cumulativeDiff = head + hunks
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff,
      failTail: "",
      round: 1,
      maxBytes: 3000,
    })
    expect(out.length).toBeLessThanOrEqual(3000)
    // `diff --git` header preserved.
    expect(out.includes("diff --git a/src/foo.py b/src/foo.py")).toBe(true)
    // First hunk header preserved.
    expect(out.includes("@@ -1,3 +1,3 @@")).toBe(true)
    // Last hunk header preserved.
    expect(out.includes("@@ -700,3 +700,3 @@")).toBe(true)
    // Some middle hunks NOT preserved.
    expect(out.includes("@@ -300,3 +300,3 @@")).toBe(false)
    // Truncation marker present.
    expect(/<\d+( middle hunks| bytes)? truncated>/.test(out)).toBe(true)
  })

  test("ordering: problem, then diff section, then fail section, then next-steps", () => {
    const out = buildRepairContext({
      problem: "PROBLEM_TEXT",
      cumulativeDiff: "DIFF_TEXT",
      failTail: "FAIL_TEXT",
      round: 1,
    })
    const iProblem = out.indexOf("PROBLEM_TEXT")
    const iDiff = out.indexOf("DIFF_TEXT")
    const iFail = out.indexOf("FAIL_TEXT")
    const iNext = out.indexOf("MANDATORY")
    expect(iProblem).toBeGreaterThan(-1)
    expect(iDiff).toBeGreaterThan(iProblem)
    expect(iFail).toBeGreaterThan(iDiff)
    expect(iNext).toBeGreaterThan(iFail)
  })

  test("empty diff and empty failTail yield a sensible placeholder, not a blank section", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "",
      round: 1,
    })
    expect(out.includes("(no diff produced yet)")).toBe(true)
    expect(out.includes("(no failure output captured)")).toBe(true)
  })

  // No-leak (output level): given BENIGN inputs the output MUST NOT name any
  // forbidden token. (Adversarial inputs that themselves carry such tokens
  // pass through verbatim — that is NOT a leak because the tokens came from
  // the model side, not the dataset; the function never reads dataset fields.)
  test("benign inputs ⇒ output contains no forbidden dataset tokens", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "diff --git a/x.py b/x.py\n@@ -1 +1 @@\n-a\n+b\n",
      failTail: "AssertionError: 1 != 2",
      round: 2,
    })
    expect(out.includes("FAIL_TO_PASS")).toBe(false)
    expect(out.includes("PASS_TO_PASS")).toBe(false)
    expect(out.includes("test_patch")).toBe(false)
    expect(out.includes("goldPatch")).toBe(false)
  })
})
