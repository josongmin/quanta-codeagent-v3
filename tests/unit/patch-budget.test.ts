import { describe, expect, test } from "bun:test"
import { analyzePatchBudget } from "@/agent/patch-budget"

/**
 * Minimal-edit admission — the django #13417 class. The MEASURED root cause of
 * over-engineering is missing minimal-patch admission, not missing verification:
 *   - gold/mini-SWE: a 1-line guard in ONE source file → within budget (admit).
 *   - quanta: a NEW `has_results_ordering()` helper method → over budget (escalate).
 * SOFT-WITH-ESCALATION: over-budget is NEVER a hard reject — it routes to the late
 * critic, so a legitimately-large fix (#14315 cross-file) survives by proving itself.
 */

// gold/mini shape: one guard line added to an existing method in one source file.
const GUARD_1LINE = `diff --git a/django/db/models/sql/query.py b/django/db/models/sql/query.py
--- a/django/db/models/sql/query.py
+++ b/django/db/models/sql/query.py
@@ -1900,6 +1900,8 @@ class Query:
     def set_values(self, fields):
         self.select_related = False
         self.clear_deferred_loading()
+        if not fields:
+            self.clear_select_fields()
         self.clear_select_clause()
`

// quanta over-engineer shape: adds a new helper METHOD (def) — the 13417 self-sabotage.
const HELPER_METHOD = `diff --git a/django/db/models/sql/query.py b/django/db/models/sql/query.py
--- a/django/db/models/sql/query.py
+++ b/django/db/models/sql/query.py
@@ -1900,6 +1900,12 @@ class Query:
     def set_values(self, fields):
         self.select_related = False
+        if self.has_results_ordering():
+            self.clear_select_fields()
         self.clear_select_clause()
+
+    def has_results_ordering(self):
+        return bool(self.order_by) and not self.distinct
`

describe("analyzePatchBudget — #13417 minimal-edit admission", () => {
  test("🟢 1-line guard, one source file ⇒ within budget (admit, no escalate)", () => {
    const v = analyzePatchBudget(GUARD_1LINE, { ownerFiles: ["django/db/models/sql/query.py"] })
    expect(v.budget.sourceFiles).toBe(1)
    expect(v.budget.newDefs).toBe(0)
    expect(v.budget.newFiles).toBe(0)
    expect(v.withinBudget).toBe(true)
    expect(v.escalate).toBe(false)
  })

  test("🔴 new helper method (def) ⇒ over budget ⇒ ESCALATE (not hard reject)", () => {
    const v = analyzePatchBudget(HELPER_METHOD, { ownerFiles: ["django/db/models/sql/query.py"] })
    expect(v.budget.newDefs).toBeGreaterThanOrEqual(1)
    expect(v.withinBudget).toBe(false)
    expect(v.escalate).toBe(true) // routes to late critic, NOT a hard kill
    expect(v.overBudgetReasons.join(" ")).toContain("new-def budget=0")
  })

  test("new file ⇒ over budget", () => {
    const newFile = `diff --git a/django/db/models/helpers.py b/django/db/models/helpers.py
new file mode 100644
--- /dev/null
+++ b/django/db/models/helpers.py
@@ -0,0 +1,2 @@
+def helper():
+    return 1
`
    const v = analyzePatchBudget(newFile)
    expect(v.budget.newFiles).toBe(1)
    expect(v.withinBudget).toBe(false)
    expect(v.overBudgetReasons.join(" ")).toContain("new-file budget=0")
  })

  // CROSS-FILE ESCAPE: #14315 needs base + postgresql. Owner-justified ⇒ within.
  test("🟢 cross-file is admitted WHEN every file is owner-justified (#14315 escape)", () => {
    const crossOwner = `diff --git a/django/db/backends/base/client.py b/django/db/backends/base/client.py
--- a/django/db/backends/base/client.py
+++ b/django/db/backends/base/client.py
@@ -10,3 +10,3 @@ class Base:
-        env = {}
+        env = None
diff --git a/django/db/backends/postgresql/client.py b/django/db/backends/postgresql/client.py
--- a/django/db/backends/postgresql/client.py
+++ b/django/db/backends/postgresql/client.py
@@ -20,3 +20,3 @@ class PG:
-        env = {}
+        env = None
`
    const owner = ["django/db/backends/base/client.py", "django/db/backends/postgresql/client.py"]
    const v = analyzePatchBudget(crossOwner, { ownerFiles: owner })
    expect(v.budget.crossFile).toBe(true)
    expect(v.budget.filesOutsideOwner).toEqual([])
    expect(v.withinBudget).toBe(true) // owner evidence justifies the 2nd file
  })

  test("🔴 cross-file WITHOUT owner justification ⇒ over budget", () => {
    const crossNoOwner = `diff --git a/a/x.py b/a/x.py
--- a/a/x.py
+++ b/a/x.py
@@ -1,1 +1,1 @@
-a
+b
diff --git a/a/y.py b/a/y.py
--- a/a/y.py
+++ b/a/y.py
@@ -1,1 +1,1 @@
-c
+d
`
    const v = analyzePatchBudget(crossNoOwner, { ownerFiles: ["a/x.py"] })
    expect(v.budget.filesOutsideOwner).toEqual(["a/y.py"])
    expect(v.withinBudget).toBe(false)
    expect(v.overBudgetReasons.join(" ")).toContain("cross-file budget=0")
  })

  test("test-only hunks don't count as source files (source-only discipline)", () => {
    const testHunk = `diff --git a/tests/test_query.py b/tests/test_query.py
--- a/tests/test_query.py
+++ b/tests/test_query.py
@@ -1,1 +1,2 @@
+def test_new():
+    pass
`
    const v = analyzePatchBudget(testHunk)
    expect(v.budget.sourceFiles).toBe(0)
    expect(v.budget.newDefs).toBe(0) // def in a TEST file is not a source new-def
    expect(v.withinBudget).toBe(true)
  })

  // ADVERSARIAL (jun-19 self-audit): a MODIFIED def signature (-def foo / +def foo)
  // must NOT count as a new def — it's an in-place edit, not a new helper. Else
  // every signature change inflates over_budget_rate and corrupts the A/B.
  test("🔴 modifying a def signature is NOT a new def (in-place edit)", () => {
    const sigChange = `diff --git a/pkg/mod.py b/pkg/mod.py
--- a/pkg/mod.py
+++ b/pkg/mod.py
@@ -10,3 +10,3 @@ class C:
-    def compute(self, a):
+    def compute(self, a, b=None):
         return a
`
    const v = analyzePatchBudget(sigChange, { ownerFiles: ["pkg/mod.py"] })
    expect(v.budget.newDefs).toBe(0) // modified, not new
    expect(v.withinBudget).toBe(true)
  })

  test("a genuinely NEW def (name only in added) still counts", () => {
    const newDef = `diff --git a/pkg/mod.py b/pkg/mod.py
--- a/pkg/mod.py
+++ b/pkg/mod.py
@@ -10,2 +10,5 @@ class C:
     def compute(self, a):
         return a
+    def helper(self):
+        return 2
`
    const v = analyzePatchBudget(newDef, { ownerFiles: ["pkg/mod.py"] })
    expect(v.budget.newDefs).toBe(1)
    expect(v.withinBudget).toBe(false)
  })

  test("runtime-expanding calls are OBSERVE-ONLY (counted, NOT gated)", () => {
    const dbCall = `diff --git a/django/db/models/sql/query.py b/django/db/models/sql/query.py
--- a/django/db/models/sql/query.py
+++ b/django/db/models/sql/query.py
@@ -1,1 +1,2 @@
     def run(self):
+        compiler = self.get_compiler(using)
`
    const v = analyzePatchBudget(dbCall, { ownerFiles: ["django/db/models/sql/query.py"] })
    expect(v.budget.runtimeExpandingCalls).toBeGreaterThanOrEqual(1)
    // observe-only: a single owner-file edit with a runtime call is STILL within budget.
    expect(v.withinBudget).toBe(true)
  })
})
