/**
 * Unified-diff file extraction hellgate.
 *
 * Shared authority for:
 *   - strict local task-language gating
 *   - strict remote prelaunch gating
 *   - verify-select candidate file ownership
 *
 * These cases pin the non-happy-path diff shapes that caused or could cause
 * false-green / wrong-language classification drift.
 */
import { describe, expect, test } from "bun:test"
import { filesFromUnifiedDiff } from "@/shared"

describe("filesFromUnifiedDiff hellgate", () => {
  test("regular edit uses the post-image path once", () => {
    expect(
      filesFromUnifiedDiff(
        [
          "diff --git a/src/old.ts b/src/new.ts",
          "--- a/src/old.ts",
          "+++ b/src/new.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      ),
    ).toEqual(["src/new.ts"])
  })

  test("pure deletion falls back to the pre-image path", () => {
    expect(
      filesFromUnifiedDiff(
        [
          "diff --git a/src/dead.py b/src/dead.py",
          "--- a/src/dead.py",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-value = 1",
        ].join("\n"),
      ),
    ).toEqual(["src/dead.py"])
  })

  test("pure addition keeps the post-image path", () => {
    expect(
      filesFromUnifiedDiff(
        [
          "diff --git a/src/new.py b/src/new.py",
          "--- /dev/null",
          "+++ b/src/new.py",
          "@@ -0,0 +1 @@",
          "+value = 1",
        ].join("\n"),
      ),
    ).toEqual(["src/new.py"])
  })

  test("pure rename without image headers falls back to diff --git post-image", () => {
    expect(
      filesFromUnifiedDiff(
        [
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 100%",
          "rename from src/old.ts",
          "rename to src/new.ts",
        ].join("\n"),
      ),
    ).toEqual(["src/new.ts"])
  })

  test("git-quoted paths are unescaped for spaces and unicode", () => {
    expect(
      filesFromUnifiedDiff(
        [
          'diff --git "a/src/space name \\353\\260\\200.py" "b/src/space name \\353\\260\\200.py"',
          '--- "a/src/space name \\353\\260\\200.py"',
          '+++ "b/src/space name \\353\\260\\200.py"',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      ),
    ).toEqual(["src/space name \ubc00.py"])
  })

  test("malformed diff --git quote is ignored but valid image headers still recover authority", () => {
    expect(
      filesFromUnifiedDiff(
        [
          'diff --git "a/src/bad.ts b/src/good.ts',
          "--- a/src/good.ts",
          "+++ b/src/good.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      ),
    ).toEqual(["src/good.ts"])
  })

  test("malformed quoted image headers fail closed instead of emitting a poisoned path", () => {
    expect(
      filesFromUnifiedDiff(
        [
          "diff --git a/src/good.ts b/src/good.ts",
          '--- "a/src/good.ts',
          '+++ "b/src/good.ts',
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      ),
    ).toEqual(["src/good.ts"])
  })
})
