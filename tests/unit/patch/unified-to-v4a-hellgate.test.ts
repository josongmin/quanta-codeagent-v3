// Hellgate test suite for unified diff → V4A converter.
//
// Each test documents the red-on-injection mutation that would flip it.

import { describe, expect, it } from "bun:test"
import { isUnifiedDiff, parsePatch, unifiedDiffToV4A } from "@/patch"

// ---------------------------------------------------------------------------
// HELL-1: canonical "--- a/ +++ b/" header is detected
// Red-on-injection: remove `t.startsWith("--- ")` branch => returns false
// ---------------------------------------------------------------------------
it("HELL-1: isUnifiedDiff detects --- a/ +++ b/ header", () => {
  expect(isUnifiedDiff("--- a/foo.py\n+++ b/foo.py\n")).toBe(true)
})

// ---------------------------------------------------------------------------
// HELL-2: git diff --git prefix is also detected
// Red-on-injection: remove `t.startsWith("diff --git ")` branch => returns false
// ---------------------------------------------------------------------------
it("HELL-2: isUnifiedDiff detects diff --git header", () => {
  expect(isUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n")).toBe(true)
})

// ---------------------------------------------------------------------------
// HELL-3: V4A patch is NOT classified as unified diff
// Red-on-injection: remove negation / remove correct check =>
//   tries to double-convert V4A => broken sentinel
// ---------------------------------------------------------------------------
it("HELL-3: isUnifiedDiff returns false for V4A patch", () => {
  expect(isUnifiedDiff("*** Begin Patch\n*** Update File: foo.py\n")).toBe(false)
})

// ---------------------------------------------------------------------------
// HELL-4: empty string => false
// ---------------------------------------------------------------------------
it("HELL-4: isUnifiedDiff returns false for empty string", () => {
  expect(isUnifiedDiff("")).toBe(false)
})

// ---------------------------------------------------------------------------
// HELL-5: leading blank lines are skipped, then --- is found => true
// ---------------------------------------------------------------------------
it("HELL-5: isUnifiedDiff ignores leading blank lines", () => {
  expect(isUnifiedDiff("   \n\n--- a/x.py\n+++ b/x.py")).toBe(true)
})

// ---------------------------------------------------------------------------
// HELL-6: round-trip update — convert unified diff, parse V4A, check ops
// Red-on-injection: change "*** Update File:" sentinel => parsePatch throws
// ---------------------------------------------------------------------------
describe("HELL-6: round-trip update hunk", () => {
  const input = [
    "--- a/src/foo.py",
    "+++ b/src/foo.py",
    "@@ -1,4 +1,4 @@ def main():",
    " line1",
    "-old_line",
    "+new_line",
    " line3",
  ].join("\n")

  let v4a: string
  it("produces V4A with Update File sentinel and path sans a/", () => {
    v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain("*** Update File: src/foo.py")
  })

  it("V4A contains the removed and added lines", () => {
    v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain("-old_line")
    expect(v4a).toContain("+new_line")
  })

  it("parsePatch produces exactly one update op", () => {
    v4a = unifiedDiffToV4A(input)
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
    expect(patch.ops[0]?.kind).toBe("update")
  })
})

// ---------------------------------------------------------------------------
// HELL-7: add file from /dev/null
// ---------------------------------------------------------------------------
it("HELL-7: /dev/null source => add op with correct path", () => {
  const input = [
    "--- /dev/null",
    "+++ b/new.py",
    "@@ -0,0 +1,2 @@",
    "+line1",
    "+line2",
  ].join("\n")
  const v4a = unifiedDiffToV4A(input)
  const patch = parsePatch(v4a)
  expect(patch.ops[0]?.kind).toBe("add")
  expect(patch.ops[0]?.path).toBe("new.py")
})

// ---------------------------------------------------------------------------
// HELL-8: delete file to /dev/null
// ---------------------------------------------------------------------------
it("HELL-8: /dev/null target => delete op with correct path", () => {
  const input = [
    "--- a/old.py",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-line1",
    "-line2",
  ].join("\n")
  const v4a = unifiedDiffToV4A(input)
  const patch = parsePatch(v4a)
  expect(patch.ops[0]?.kind).toBe("delete")
  expect(patch.ops[0]?.path).toBe("old.py")
})

// ---------------------------------------------------------------------------
// HELL-9: multi-file diff => two ops
// ---------------------------------------------------------------------------
it("HELL-9: multi-file unified diff produces two ops", () => {
  const input = [
    "--- a/alpha.py",
    "+++ b/alpha.py",
    "@@ -1 +1 @@",
    "-old_alpha",
    "+new_alpha",
    "--- a/beta.py",
    "+++ b/beta.py",
    "@@ -1 +1 @@",
    "-old_beta",
    "+new_beta",
  ].join("\n")
  const v4a = unifiedDiffToV4A(input)
  const patch = parsePatch(v4a)
  expect(patch.ops).toHaveLength(2)
  expect(patch.ops[0]?.kind).toBe("update")
  expect(patch.ops[1]?.kind).toBe("update")
})

// ---------------------------------------------------------------------------
// HELL-10: git meta lines are skipped — not turned into bogus ops
// ---------------------------------------------------------------------------
it("HELL-10: git meta lines produce no extra ops", () => {
  const input = [
    "diff --git a/x.py b/x.py",
    "index abc..def 100644",
    "--- a/x.py",
    "+++ b/x.py",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n")
  const v4a = unifiedDiffToV4A(input)
  const patch = parsePatch(v4a)
  expect(patch.ops).toHaveLength(1)
  expect(patch.ops[0]?.kind).toBe("update")
  expect(patch.ops[0]?.path).toBe("x.py")
})

// ---------------------------------------------------------------------------
// HELL-11: V4A patch string is not double-converted (isUnifiedDiff gate)
// ---------------------------------------------------------------------------
it("HELL-11: isUnifiedDiff returns false for a V4A patch with Begin Patch", () => {
  const v4a = [
    "*** Begin Patch",
    "*** Update File: src/foo.py",
    "@@ def main():",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n")
  // Gate must return false — caller would NOT call unifiedDiffToV4A
  expect(isUnifiedDiff(v4a)).toBe(false)
})

// ---------------------------------------------------------------------------
// HELL-12: path without a/ or b/ prefix is left intact
// ---------------------------------------------------------------------------
it("HELL-12: path without git prefix is not stripped", () => {
  const input = [
    "--- foo.py",
    "+++ foo.py",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n")
  const v4a = unifiedDiffToV4A(input)
  const patch = parsePatch(v4a)
  expect(patch.ops[0]?.path).toBe("foo.py")
})
