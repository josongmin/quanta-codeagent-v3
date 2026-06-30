/**
 * T-101 — closure diagnostics IO. Teeth on the impure boundary: diff parsing,
 * stray detection, the #9296 (max_turns empty-patch) classification path, and
 * the oracle never being consulted as anything but post-hoc gold.
 */
import { describe, expect, test } from "bun:test"
import {
  buildFacts,
  diagnoseRun,
  patchFiles,
  strayFilesOf,
} from "@/runner/batch/eval/closure-diagnostics-io"
import type { InstanceResult } from "@/runner/batch/types"

const DIFF = `diff --git a/pkg/a.py b/pkg/a.py
--- a/pkg/a.py
+++ b/pkg/a.py
@@ -1 +1 @@
-x
+y
diff --git a/test.html.Z b/test.html.Z
new file mode 100644
`

describe("closure-diagnostics-io", () => {
  test("patchFiles extracts repo-relative paths in order", () => {
    expect(patchFiles(DIFF)).toEqual(["pkg/a.py", "test.html.Z"])
    expect(patchFiles("")).toEqual([])
  })

  test("strayFilesOf (via T-401 hygiene) flags added junk, not real source", () => {
    const diff =
      "diff --git a/test.html.Z b/test.html.Z\nnew file mode 100644\n" +
      "diff --git a/django/core/paginator.py b/django/core/paginator.py\n--- a/django/core/paginator.py\n+++ b/django/core/paginator.py\n"
    expect(strayFilesOf(diff)).toEqual(["test.html.Z"])
    expect(
      strayFilesOf("diff --git a/django/core/paginator.py b/django/core/paginator.py\n"),
    ).toEqual([])
  })

  test("buildFacts maps max_turns empty patch to the #9296 class signal", () => {
    const r: InstanceResult = {
      id: "nopatch",
      passed: false,
      patch: "",
      turns: 60,
      budget: {
        baseTimeoutMs: 1,
        adaptedTimeoutMs: 1,
        attempts: 1,
        attemptOutcomes: [{ kind: "real-fail", subkind: "max_turns_exhausted" }],
      },
    }
    const f = buildFacts([r])[0]!
    expect(f.emptyPatch).toBe(true)
    expect(f.endReason).toBe("max_turns")
  })

  test("buildFacts maps budget_exhausted empty patch to its own endReason", () => {
    const r: InstanceResult = {
      id: "nopatch-budget",
      passed: false,
      patch: "",
      turns: 60,
      budget: {
        baseTimeoutMs: 1,
        adaptedTimeoutMs: 1,
        attempts: 1,
        attemptOutcomes: [{ kind: "real-fail", subkind: "budget_exhausted" }],
      },
    }
    const f = buildFacts([r])[0]!
    expect(f.emptyPatch).toBe(true)
    expect(f.endReason).toBe("budget_exhausted")
  })

  test("buildFacts maps strict admission blocks to admission_blocked endReason", () => {
    const r: InstanceResult = {
      id: "strict-block",
      passed: false,
      patch: "",
      turns: 8,
      admissionBlock: { kind: "patch_budget_strict" },
      budget: {
        baseTimeoutMs: 1,
        adaptedTimeoutMs: 1,
        attempts: 1,
        attemptOutcomes: [
          {
            kind: "admission-blocked",
            source: "patch_budget_strict",
            reason: "patch budget exceeded",
          },
        ],
      },
    }
    const f = buildFacts([r])[0]!
    expect(f.emptyPatch).toBe(true)
    expect(f.endReason).toBe("admission_blocked")
  })

  test("buildFacts derives over_budget/new_def/cross_file from patchBudget (jun-19)", () => {
    const over: InstanceResult = {
      id: "over",
      passed: false,
      patch: "diff --git a/x.py b/x.py\n",
      turns: 1,
      patchBudget: {
        budget: {
          sourceFiles: 2,
          newFiles: 0,
          newDefs: 1,
          crossFile: true,
          filesOutsideOwner: ["y.py"],
          runtimeExpandingCalls: 0,
        },
        withinBudget: false,
        overBudgetReasons: ["new-def budget=0"],
        escalate: true,
      },
    }
    const f = buildFacts([over])[0]!
    expect(f.overBudget).toBe(true)
    expect(f.newDef).toBe(true)
    expect(f.crossFile).toBe(true)
  })

  test("buildFacts: absent patchBudget still derives crossFile offline while other budget facts stay null", () => {
    const r: InstanceResult = {
      id: "none",
      passed: true,
      patch: "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n",
      turns: 1,
    }
    const f = buildFacts([r])[0]!
    expect(f.overBudget).toBeNull()
    expect(f.newDef).toBeNull()
    expect(f.crossFile).toBe(false)
  })

  test("buildFacts: absent patchBudget + multi-source diff ⇒ crossFile stays observable", () => {
    const r: InstanceResult = {
      id: "cross",
      passed: false,
      patch: [
        "diff --git a/x.py b/x.py",
        "--- a/x.py",
        "+++ b/x.py",
        "@@",
        "-old",
        "+new",
        "diff --git a/y.py b/y.py",
        "--- a/y.py",
        "+++ b/y.py",
        "@@",
        "-old",
        "+new",
      ].join("\n"),
      turns: 1,
    }
    const f = buildFacts([r])[0]!
    expect(f.overBudget).toBeNull()
    expect(f.newDef).toBeNull()
    expect(f.crossFile).toBe(true)
  })

  test("buildFacts treats verdict-excluded instances as ungraded (resolved=null)", () => {
    const r: InstanceResult = {
      id: "degraded",
      passed: false,
      patch: "diff --git a/x.py b/x.py\n",
      turns: 1,
      verdict: "grader_invalid",
    }
    expect(buildFacts([r])[0]!.resolved).toBeNull()
  })

  test("diagnoseRun with no dataset → owner metrics unavailable, no crash", () => {
    const r: InstanceResult = {
      id: "x",
      passed: true,
      patch: "diff --git a/x.py b/x.py\n",
      turns: 3,
    }
    const d = diagnoseRun([r], undefined)
    expect(d.total).toBe(1)
    expect(d.metrics["owner_recall@1"]!.available).toBe(false)
  })
})
