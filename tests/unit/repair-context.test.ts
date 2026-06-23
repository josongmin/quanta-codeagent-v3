import { describe, expect, test } from "bun:test"
import { buildRepairContext } from "../../src/apps/bench/eval/repair/context"

const SMALL_PROBLEM = "Fix the `foo()` function so that `foo(0)` returns 1 instead of 0."

describe("buildRepairContext (pure repair seed builder)", () => {
  test("WS2 widen: siblingOwners ⇒ co-change section (deduped); empty ⇒ byte-identical", () => {
    const base = buildRepairContext({ problem: "p", cumulativeDiff: "", failTail: "boom", round: 1 })
    expect(base).not.toContain("Co-change sites")

    const widened = buildRepairContext({
      problem: "p",
      cumulativeDiff: "",
      failTail: "boom",
      round: 1,
      siblingOwners: [
        "django/db/backends/postgresql/client.py",
        "django/db/backends/postgresql/client.py", // dup
        "django/db/backends/mysql/client.py",
      ],
    })
    expect(widened).toContain("Co-change sites")
    expect(widened).toContain("- django/db/backends/postgresql/client.py")
    expect(widened).toContain("- django/db/backends/mysql/client.py")
    // deduped: postgresql listed exactly once
    expect(widened.split("postgresql/client.py").length - 1).toBe(1)
    // empty list ⇒ byte-identical to the no-sibling seed
    expect(
      buildRepairContext({ problem: "p", cumulativeDiff: "", failTail: "boom", round: 1, siblingOwners: [] }),
    ).toBe(base)
  })

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

  test("tiny maxBytes still hard-caps the full prompt", () => {
    const huge = "X".repeat(50_000)
    const out = buildRepairContext({
      problem: huge,
      cumulativeDiff: huge,
      failTail: huge,
      validationSource: "primary_rail",
      validationCmd: `python "${"a".repeat(500)}"`,
      validationExitCode: 1,
      round: 2,
      maxBytes: 256,
    })
    expect(out.length).toBeLessThanOrEqual(256)
    expect(/<\d+ bytes truncated>/.test(out)).toBe(true)
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

  test("structured failureEvidence is authoritative over a stale failTail projection", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "STALE_HEAD_ONLY",
      failureEvidence: {
        stdoutTail: "",
        stderrTail: "",
        combinedTail: "REAL_FAILURE_TAIL",
      },
      round: 1,
    })
    expect(out).toContain("REAL_FAILURE_TAIL")
    expect(out).not.toContain("STALE_HEAD_ONLY")
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

  test("predicate mismatch summary is surfaced before the validator tail when provided", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "DIFF_TEXT",
      failTail: "FAIL_TEXT",
      predicateSummary: "Typed rail mismatch: stdout missing substring `expected output`.",
      round: 1,
    })
    const iPredicate = out.indexOf("Typed rail note:")
    const iFail = out.indexOf("Validation failed. Tail of failing output:")
    expect(iPredicate).toBeGreaterThan(-1)
    expect(iFail).toBeGreaterThan(iPredicate)
    expect(out).toContain("stdout missing substring")
  })

  test("validation gate section names the primary rail command and exit code", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "DIFF_TEXT",
      failTail: "FAIL_TEXT",
      validationSource: "primary_rail",
      validationCmd: 'python "reproduce_issue.py"',
      validationExitCode: 1,
      round: 1,
    })
    expect(out).toContain("Validation gate:")
    expect(out).toContain("PRIMARY RAIL")
    expect(out).toContain('Command: python "reproduce_issue.py"')
    expect(out).toContain("Exit code: 1")
  })

  test("missing validation signal is surfaced explicitly instead of a blank gate", () => {
    const out = buildRepairContext({
      problem: SMALL_PROBLEM,
      cumulativeDiff: "",
      failTail: "",
      validationSource: "none",
      round: 1,
    })
    expect(out).toContain("No verification command or reproduction script was captured")
    expect(out).toContain("run a concrete verification command")
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
