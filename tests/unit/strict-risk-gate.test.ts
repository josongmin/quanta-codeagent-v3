import { describe, expect, test } from "bun:test"
import { evaluateStrictPatchRisk } from "@/runner/batch/eval/strict-risk-gate"

const SEABORN_SINGLE_FILE_AXIS_PATCH = `diff --git a/seaborn/_core/plot.py b/seaborn/_core/plot.py
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

const SEABORN_MULTI_FILE_PATCH = `diff --git a/seaborn/_core/plot.py b/seaborn/_core/plot.py
--- a/seaborn/_core/plot.py
+++ b/seaborn/_core/plot.py
@@ -25,7 +25,7 @@
-from seaborn._core.scales import Scale
+from seaborn._core.scales import Scale, Nominal
diff --git a/seaborn/_core/scales.py b/seaborn/_core/scales.py
--- a/seaborn/_core/scales.py
+++ b/seaborn/_core/scales.py
@@ -143,6 +143,7 @@ class Nominal(Scale):
+    _matplotlib_props = {"axis_margin": 0, "grid": False, "inverse": True}
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
  test("does not inspect problem-specific axis semantics", () => {
    const decision = evaluateStrictPatchRisk({
      patch: SEABORN_SINGLE_FILE_AXIS_PATCH,
      problemStatement:
        "Nominal x and y axes should preserve explicit limits, disable grid lines, and keep y axis inverted.",
      ownerFiles: ["seaborn/_core/plot.py"],
      repo: "mwaskom/seaborn",
    })
    expect(decision.expand).toBe(false)
    expect(decision.reasons).toEqual([])
  })

  test("routes multi-source-file patches to the extra candidate path even when owner-ranked", () => {
    const decision = evaluateStrictPatchRisk({
      patch: SEABORN_MULTI_FILE_PATCH,
      problemStatement: "Any issue text is ignored by the structural gate.",
      ownerFiles: ["seaborn/_core/plot.py", "seaborn/_core/scales.py"],
      repo: "mwaskom/seaborn",
    })
    expect(decision.expand).toBe(true)
    expect(decision.patchBudget.budget.sourceFiles).toBe(2)
    expect(decision.reasons.join("\n")).toContain("patch-budget:source-file budget=1")
  })

  test("routes a new helper to the extra candidate path (runtime-expand now observe-only)", () => {
    const decision = evaluateStrictPatchRisk({
      patch: DJANGO_HELPER_RUNTIME,
      problemStatement:
        "Query ordering should not require compiler setup for a simple group_by guard.",
      ownerFiles: ["django/db/models/sql/query.py"],
      repo: "django/django",
    })
    // The new-def dimension still routes to expansion...
    expect(decision.expand).toBe(true)
    expect(decision.reasons.join("\n")).toContain("patch-budget:new-def budget=0")
    // ...but the django-specific runtime-expanding heuristic was demoted to
    // observe-only (jun-22) — it must NOT over-budget / route on its own.
    expect(decision.reasons.join("\n")).not.toContain("runtime-expanding")
  })
})
