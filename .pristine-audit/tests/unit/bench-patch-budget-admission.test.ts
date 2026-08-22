import { describe, expect, test } from "bun:test"
import type { ClosureSessionState } from "@/runner/batch/eval/closure-session"
import {
  buildPhasePatchBudget,
  patchBudgetOwnerFiles,
} from "@/runner/batch/eval/patch-budget-admission"

const sessionWithOwnerResolved = (): ClosureSessionState =>
  ({
    input: {
      evidence: {
        issueText: "backend parity bug",
        stage1Files: [{ file: "django/db/backends/mysql/operations.py", score: 2 }],
        ownerResolved: [
          { file: "django/db/backends/oracle/operations.py", forSymbol: "_convert_field_to_tz" },
          { file: "django/db/backends/sqlite3/operations.py", forSymbol: "_convert_field_to_tz" },
        ],
      },
      plan: {},
      gate: {
        stakes: { patchFileCount: 1, crossFile: false, destructive: false },
        uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
        signal: { reproAvailable: false, lspAvailable: true },
        issueProvidesFix: false,
      },
    },
    bundle: {
      evidence: {
        candidates: [
          {
            file: "django/db/backends/mysql/operations.py",
            score: 2,
            sources: ["stage1"],
            symbols: [],
          },
        ],
        issueSymbols: [],
        truncated: false,
        partial: false,
      },
      owner: {
        admit: true,
        owner: "django/db/backends/mysql/operations.py",
        coverageExpectation: "owner-family",
        siblingCoverageExpected: true,
        reason: "test fixture",
      },
      plan: {
        primaryRail: undefined,
        required: [],
        optional: [],
        baseValidatedRed: false,
      },
      gate: {
        action: "verify",
        reason: "test fixture",
      },
    },
  }) as unknown as ClosureSessionState

const BACKEND_FAMILY_PATCH = `diff --git a/django/db/backends/mysql/operations.py b/django/db/backends/mysql/operations.py
--- a/django/db/backends/mysql/operations.py
+++ b/django/db/backends/mysql/operations.py
@@ -1,1 +1,1 @@
-a
+b
diff --git a/django/db/backends/oracle/operations.py b/django/db/backends/oracle/operations.py
--- a/django/db/backends/oracle/operations.py
+++ b/django/db/backends/oracle/operations.py
@@ -1,1 +1,1 @@
-c
+d
diff --git a/django/db/backends/sqlite3/operations.py b/django/db/backends/sqlite3/operations.py
--- a/django/db/backends/sqlite3/operations.py
+++ b/django/db/backends/sqlite3/operations.py
@@ -1,1 +1,1 @@
-e
+f
`

describe("patch-budget admission — closure owner-family escape", () => {
  test("owner files include explicit ownerResolved siblings, not only ranked candidates", () => {
    expect(patchBudgetOwnerFiles(sessionWithOwnerResolved())).toEqual([
      "django/db/backends/mysql/operations.py",
      "django/db/backends/oracle/operations.py",
      "django/db/backends/sqlite3/operations.py",
    ])
  })

  test("strict budget admits backend-family cross-file patch when ownerResolved covers every file", () => {
    const v = buildPhasePatchBudget({
      patch: BACKEND_FAMILY_PATCH,
      repo: "django/django",
      closureSession: sessionWithOwnerResolved(),
      strict: true,
    })
    expect(v.budget.crossFile).toBe(true)
    expect(v.budget.filesOutsideOwner).toEqual([])
    expect(v.withinBudget).toBe(true)
  })

  test("same cross-file patch is still blocked without closure owner-family evidence", () => {
    const v = buildPhasePatchBudget({
      patch: BACKEND_FAMILY_PATCH,
      repo: "django/django",
      closureSession: undefined,
      strict: true,
    })
    expect(v.withinBudget).toBe(false)
    expect(v.overBudgetReasons.join(" ")).toContain("source-file budget=1")
  })
})
