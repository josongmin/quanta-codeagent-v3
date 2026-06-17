/**
 * T-101 — closure diagnostics IO. Teeth on the impure boundary: diff parsing,
 * stray detection, the #9296 (max_turns empty-patch) classification path, and
 * the oracle never being consulted as anything but post-hoc gold.
 */
import { describe, expect, test } from "bun:test"
import type { InstanceResult } from "@/runner/batch/types"
import {
  buildFacts,
  diagnoseRun,
  patchFiles,
  strayFilesOf,
} from "@/runner/batch/eval/closure-diagnostics-io"

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

  test("strayFilesOf flags junk artifacts, not real source", () => {
    expect(strayFilesOf(["pkg/a.py", "test.html.Z", "x.orig", "y.rej"])).toEqual([
      "test.html.Z",
      "x.orig",
      "y.rej",
    ])
    expect(strayFilesOf(["django/core/paginator.py"])).toEqual([])
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
    const [f] = buildFacts([r])
    expect(f.emptyPatch).toBe(true)
    expect(f.endReason).toBe("max_turns")
  })

  test("buildFacts treats verdict-excluded instances as ungraded (resolved=null)", () => {
    const r: InstanceResult = {
      id: "degraded",
      passed: false,
      patch: "diff --git a/x.py b/x.py\n",
      turns: 1,
      verdict: "grader_invalid",
    }
    expect(buildFacts([r])[0].resolved).toBeNull()
  })

  test("diagnoseRun with no dataset → owner metrics unavailable, no crash", () => {
    const r: InstanceResult = { id: "x", passed: true, patch: "diff --git a/x.py b/x.py\n", turns: 3 }
    const d = diagnoseRun([r], undefined)
    expect(d.total).toBe(1)
    expect(d.metrics["owner_recall@1"].available).toBe(false)
  })
})
