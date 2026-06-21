import { describe, expect, test } from "bun:test"
import { evaluateStrictPatchRisk } from "@/runner/batch/eval/strict-risk-gate"

const SEABORN_AXIS_ISSUE =
  "Nominal x and y axes should preserve explicit limits, disable grid lines, and keep y axis inverted."

const STRICT_SEABORN_NEAR_MISS = `diff --git a/seaborn/_core/plot.py b/seaborn/_core/plot.py
--- a/seaborn/_core/plot.py
+++ b/seaborn/_core/plot.py
@@ -1,3 +1,12 @@
+    if isinstance(self._scales.get(axis_key), Nominal):
+        n = len(getattr(ax, f"get_{axis}ticks")())
+        if axis == "x":
+            ax.xaxis.grid(False)
+        else:
+            ax.yaxis.grid(False)
+            ax.invert_yaxis()
+        ax.set(**{f"{axis}lim": (-.5, n - .5)})
`

const SEABORN_REVERSED_YLIMIT = `diff --git a/seaborn/_core/plot.py b/seaborn/_core/plot.py
--- a/seaborn/_core/plot.py
+++ b/seaborn/_core/plot.py
@@ -1,3 +1,11 @@
+    if isinstance(scale, Nominal):
+        n = len(getattr(ax, f"get_{axis}ticks")())
+        if axis == "x":
+            ax.xaxis.grid(False)
+            ax.set_xlim(-.5, n - .5, auto=None)
+        else:
+            ax.yaxis.grid(False)
+            ax.set_ylim(n - .5, -.5, auto=None)
`

const DJANGO_HELPER_RUNTIME = `diff --git a/django/db/models/sql/query.py b/django/db/models/sql/query.py
--- a/django/db/models/sql/query.py
+++ b/django/db/models/sql/query.py
@@ -1225,3 +1225,9 @@ class Query:
+        if self.has_results_ordering():
+            return True
+
+    def has_results_ordering(self):
+        compiler = self.get_compiler(using="default")
+        return compiler.pre_sql_setup()
`

describe("evaluateStrictPatchRisk", () => {
  test("flags seaborn-style y inversion overwritten by a later ascending generic limit", () => {
    const decision = evaluateStrictPatchRisk({
      patch: STRICT_SEABORN_NEAR_MISS,
      problemStatement: SEABORN_AXIS_ISSUE,
      ownerFiles: ["seaborn/_core/plot.py"],
      repo: "mwaskom/seaborn",
    })
    expect(decision.expand).toBe(true)
    expect(decision.reasons).toContain("axis-inversion-overwritten-by-ascending-limit")
    expect(decision.reasons).toContain("explicit-limit-preservation-not-evidenced")
  })

  test("accepts direct reversed y-limit axis handling as low risk", () => {
    const decision = evaluateStrictPatchRisk({
      patch: SEABORN_REVERSED_YLIMIT,
      problemStatement: SEABORN_AXIS_ISSUE,
      ownerFiles: ["seaborn/_core/plot.py"],
      repo: "mwaskom/seaborn",
    })
    expect(decision.expand).toBe(false)
    expect(decision.reasons).toEqual([])
  })

  test("routes new helper plus compiler setup expansion to the extra candidate path", () => {
    const decision = evaluateStrictPatchRisk({
      patch: DJANGO_HELPER_RUNTIME,
      problemStatement: "Query ordering should not require compiler setup for a simple group_by guard.",
      ownerFiles: ["django/db/models/sql/query.py"],
      repo: "django/django",
    })
    expect(decision.expand).toBe(true)
    expect(decision.reasons.join("\n")).toContain("patch-budget:new-def budget=0")
    expect(decision.reasons.join("\n")).toContain("patch-budget:runtime-expanding budget=0")
  })
})
