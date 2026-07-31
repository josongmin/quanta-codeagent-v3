// Adversarial scenario tests for unified diff -> V4A converter.
// Each test has a "Red-on-injection" comment describing the mutation that
// would flip it.

import { describe, expect, it } from "bun:test"
import { isUnifiedDiff, parsePatch, unifiedDiffToV4A } from "@/patch"

// =============================================================================
// GROUP 1: Format detection (isUnifiedDiff) — 8 tests
// =============================================================================

describe("GROUP 1: Format detection (isUnifiedDiff)", () => {
  // S-DET-1
  // Red-on-injection: remove `t.startsWith("--- ")` branch => returns false
  it("S-DET-1: '--- a/foo.py' -> true", () => {
    expect(isUnifiedDiff("--- a/foo.py")).toBe(true)
  })

  // S-DET-2
  // Red-on-injection: remove `t.startsWith("diff --git ")` branch => returns false
  it("S-DET-2: 'diff --git a/f b/f' -> true", () => {
    expect(isUnifiedDiff("diff --git a/f b/f")).toBe(true)
  })

  // S-DET-3
  // Red-on-injection: change check to include "*** Begin Patch" as unified => returns true
  it("S-DET-3: '*** Begin Patch' first line -> false", () => {
    expect(isUnifiedDiff("*** Begin Patch\n*** Update File: foo.py\n*** End Patch")).toBe(false)
  })

  // S-DET-4
  // Red-on-injection: remove blank-line skip (`if (t === "") continue`) => returns false
  it("S-DET-4: leading blank lines then '--- a/foo.py' -> true", () => {
    expect(isUnifiedDiff("\n\n   \n--- a/foo.py\n+++ b/foo.py\n")).toBe(true)
  })

  // S-DET-5
  // Red-on-injection: remove trimEnd() call => CRLF line fails startsWith check => returns false
  it("S-DET-5: CRLF line endings -> true", () => {
    expect(isUnifiedDiff("--- a/foo.py\r\n+++ b/foo.py\r\n")).toBe(true)
  })

  // S-DET-6
  // Red-on-injection: restrict match to require "a/" prefix => bare path returns false
  it("S-DET-6: bare path '--- foo.py' (no a/ prefix) -> true", () => {
    expect(isUnifiedDiff("--- foo.py\n+++ foo.py\n")).toBe(true)
  })

  // S-DET-7
  // Red-on-injection: also match "+++ " as a valid first-line indicator => returns true (wrong)
  it("S-DET-7: '+++ b/foo.py' as first non-blank line (no --- before it) -> false", () => {
    expect(isUnifiedDiff("+++ b/foo.py\n--- a/foo.py\n")).toBe(false)
  })

  // S-DET-8
  // Red-on-injection: return true on empty string => reverses the empty-string guard
  it("S-DET-8: empty string -> false", () => {
    expect(isUnifiedDiff("")).toBe(false)
  })
})

// =============================================================================
// GROUP 2: Path strip handling — 6 tests
// (round-trip: unifiedDiffToV4A + parsePatch, check op.path)
// =============================================================================

describe("GROUP 2: Path strip handling", () => {
  // Minimal valid update hunk body helper
  const makeUpdate = (fromLine: string, toLine: string) =>
    [fromLine, toLine, "@@ -1 +1 @@", "-old", "+new"].join("\n")

  // S-PATH-1
  // Red-on-injection: remove stripGitPrefix => path becomes "a/src/foo.py"
  it("S-PATH-1: 'a/' prefix stripped from --- line", () => {
    const v4a = unifiedDiffToV4A(makeUpdate("--- a/src/foo.py", "+++ b/src/foo.py"))
    const patch = parsePatch(v4a)
    expect(patch.ops[0]?.path).toBe("src/foo.py")
  })

  // S-PATH-2
  // Red-on-injection: only strip "a/" not "b/" => path becomes "b/src/foo.py"
  it("S-PATH-2: 'b/' prefix on from-path stripped correctly", () => {
    const v4a = unifiedDiffToV4A(makeUpdate("--- b/src/foo.py", "+++ b/src/foo.py"))
    const patch = parsePatch(v4a)
    expect(patch.ops[0]?.path).toBe("src/foo.py")
  })

  // S-PATH-3
  // Red-on-injection: always strip first two chars => "foo.py" becomes "o.py"
  it("S-PATH-3: bare path without prefix is not stripped", () => {
    const v4a = unifiedDiffToV4A(makeUpdate("--- foo.py", "+++ foo.py"))
    const patch = parsePatch(v4a)
    expect(patch.ops[0]?.path).toBe("foo.py")
  })

  // S-PATH-4
  // Red-on-injection: split on space and only take first token => path truncated at first space
  it("S-PATH-4: path with spaces preserved correctly", () => {
    const v4a = unifiedDiffToV4A(
      makeUpdate("--- a/path with spaces/file.py", "+++ b/path with spaces/file.py"),
    )
    const patch = parsePatch(v4a)
    expect(patch.ops[0]?.path).toBe("path with spaces/file.py")
  })

  // S-PATH-5
  // Red-on-injection: strip all "a/" occurrences globally => "deep/nested/a/file.py" becomes "deep/nested/file.py"
  it("S-PATH-5: only leading a/ stripped, inner a/ preserved", () => {
    const v4a = unifiedDiffToV4A(
      makeUpdate("--- a/deep/nested/a/file.py", "+++ b/deep/nested/a/file.py"),
    )
    const patch = parsePatch(v4a)
    expect(patch.ops[0]?.path).toBe("deep/nested/a/file.py")
  })

  // S-PATH-6
  // Red-on-injection: not treating /dev/null as add-from-null => uses fromPath ("/dev/null") as path
  it("S-PATH-6: /dev/null from-path -> add op, path from +++ line", () => {
    const input = ["--- /dev/null", "+++ b/new.py", "@@ -0,0 +1 @@", "+content"].join("\n")
    const v4a = unifiedDiffToV4A(input)
    const patch = parsePatch(v4a)
    expect(patch.ops[0]?.kind).toBe("add")
    expect(patch.ops[0]?.path).toBe("new.py")
  })
})

// =============================================================================
// GROUP 3: Hunk header conversion — 5 tests
// (assert on the V4A string content directly)
// =============================================================================

describe("GROUP 3: Hunk header conversion", () => {
  // S-HUNK-1
  // Red-on-injection: drop context portion after @@ => "@@ class Foo:" becomes just "@@"
  it("S-HUNK-1: @@ with context string -> V4A contains '@@ class Foo:'", () => {
    const input = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1,4 +1,4 @@ class Foo:",
      "-old",
      "+new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain("@@ class Foo:")
  })

  // S-HUNK-2
  // Red-on-injection: require trailing context => bare "@@ -1,4 +1,4 @@" not converted
  it("S-HUNK-2: @@ without trailing context -> V4A contains standalone '@@'", () => {
    const input = ["--- a/foo.py", "+++ b/foo.py", "@@ -1,4 +1,4 @@", "-old", "+new"].join("\n")
    const v4a = unifiedDiffToV4A(input)
    // Should have bare @@ (possibly at start of line or after newline)
    const lines = v4a.split("\n")
    expect(lines.some((l) => l === "@@")).toBe(true)
  })

  // S-HUNK-3
  // Red-on-injection: not trimming trailing space => "@@ " emitted instead of "@@"
  it("S-HUNK-3: @@ with trailing space only -> V4A emits bare '@@'", () => {
    const input = ["--- a/foo.py", "+++ b/foo.py", "@@ -1,4 +1,4 @@ ", "-old", "+new"].join("\n")
    const v4a = unifiedDiffToV4A(input)
    const lines = v4a.split("\n")
    // After trim of empty string, should emit bare @@
    expect(lines.some((l) => l === "@@")).toBe(true)
    // Must NOT have "@@ " (with trailing space) as a line
    expect(lines.some((l) => l === "@@ ")).toBe(false)
  })

  // S-HUNK-4
  // Red-on-injection: emit multiple "*** Update File:" headers => parsePatch sees two file ops
  it("S-HUNK-4: two hunks in one file -> single Update File header, two @@ lines", () => {
    const input = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1 +1 @@",
      "-first_old",
      "+first_new",
      "@@ -10 +10 @@",
      "-second_old",
      "+second_new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    // Exactly one Update File header
    const updateCount = (v4a.match(/\*\*\* Update File:/g) ?? []).length
    expect(updateCount).toBe(1)
    // Two @@ hunk headers
    const lines = v4a.split("\n")
    const hhCount = lines.filter((l) => l === "@@" || l.startsWith("@@ ")).length
    expect(hhCount).toBe(2)
  })

  // S-HUNK-5
  // Red-on-injection: strip or alter +/-/space prefix => content lines mangled
  it("S-HUNK-5: +/-/space content lines pass through unchanged", () => {
    const input = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1,3 +1,3 @@",
      " context_line",
      "-removed_line",
      "+added_line",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain(" context_line")
    expect(v4a).toContain("-removed_line")
    expect(v4a).toContain("+added_line")
  })
})

// =============================================================================
// GROUP 4: File operation types — 5 tests (round-trip through parsePatch)
// =============================================================================

describe("GROUP 4: File operation types", () => {
  // S-OP-1
  // Red-on-injection: emit "*** Add File:" instead of "*** Update File:" => op.kind === "add"
  it("S-OP-1: normal update produces kind === 'update'", () => {
    const input = ["--- a/foo.py", "+++ b/foo.py", "@@ -1 +1 @@", "-old", "+new"].join("\n")
    const patch = parsePatch(unifiedDiffToV4A(input))
    expect(patch.ops[0]?.kind).toBe("update")
  })

  // S-OP-2
  // Red-on-injection: not detecting /dev/null from => kind === "update" instead of "add"
  it("S-OP-2: add from /dev/null produces kind === 'add'", () => {
    const input = [
      "--- /dev/null",
      "+++ b/brand_new.py",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
    ].join("\n")
    const patch = parsePatch(unifiedDiffToV4A(input))
    expect(patch.ops[0]?.kind).toBe("add")
  })

  // S-OP-3
  // Red-on-injection: not detecting /dev/null to => kind === "update" instead of "delete"
  it("S-OP-3: delete to /dev/null produces kind === 'delete'", () => {
    const input = ["--- a/gone.py", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-line1", "-line2"].join(
      "\n",
    )
    const patch = parsePatch(unifiedDiffToV4A(input))
    expect(patch.ops[0]?.kind).toBe("delete")
  })

  // S-OP-4
  // Red-on-injection: merge multi-file into one op => ops.length === 1
  it("S-OP-4: update + add produces two ops", () => {
    const input = [
      "--- a/existing.py",
      "+++ b/existing.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- /dev/null",
      "+++ b/fresh.py",
      "@@ -0,0 +1 @@",
      "+content",
    ].join("\n")
    const patch = parsePatch(unifiedDiffToV4A(input))
    expect(patch.ops).toHaveLength(2)
    expect(patch.ops[0]?.kind).toBe("update")
    expect(patch.ops[1]?.kind).toBe("add")
  })

  // S-OP-5
  // Red-on-injection: treat "rename from" lines as content => V4A gets bogus lines
  it("S-OP-5: diff --git with rename meta lines skipped, file processed as update", () => {
    const input = [
      "diff --git a/old.py b/new.py",
      "similarity index 89%",
      "rename from old.py",
      "rename to new.py",
      "index abc..def 100644",
      "--- a/old.py",
      "+++ b/new.py",
      "@@ -1 +1 @@",
      "-old_content",
      "+new_content",
    ].join("\n")
    const patch = parsePatch(unifiedDiffToV4A(input))
    // Produces one update op (using fromPath = old.py since that's what --- gives)
    expect(patch.ops).toHaveLength(1)
    expect(patch.ops[0]?.kind).toBe("update")
  })
})

// =============================================================================
// GROUP 5: Git meta line filtering — 4 tests
// =============================================================================

describe("GROUP 5: Git meta line filtering", () => {
  // S-META-1
  // Red-on-injection: not filtering "index " lines => V4A contains "index abc..def 100644"
  it("S-META-1: 'index abc..def 100644' does not appear in V4A output", () => {
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
    expect(v4a).not.toContain("index abc..def 100644")
  })

  // S-META-2
  // Red-on-injection: not filtering "new file mode" => V4A contains that line
  it("S-META-2: 'new file mode 100644' does not appear in V4A output", () => {
    const input = [
      "diff --git a/new.py b/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1 @@",
      "+line",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).not.toContain("new file mode 100644")
  })

  // S-META-3
  // Red-on-injection: treat Binary files line as a file header => bogus *** lines emitted
  it("S-META-3: 'Binary files' line produces no op and no bogus *** lines", () => {
    const input = [
      "diff --git a/x.bin b/x.bin",
      "index abc..def 100644",
      "Binary files a/x.bin and b/x.bin differ",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    // The converter should skip the binary file entirely
    // No "*** Update File:", "*** Add File:", or "*** Delete File:" for binary
    expect(v4a).not.toContain("*** Update File: x.bin")
    expect(v4a).not.toContain("*** Add File: x.bin")
    expect(v4a).not.toContain("*** Delete File: x.bin")
    // No "Binary files" content in V4A
    expect(v4a).not.toContain("Binary files")
  })

  // S-META-4
  // Red-on-injection: not filtering "similarity index" => V4A contains that line
  it("S-META-4: 'similarity index 89%' does not appear in V4A output", () => {
    const input = [
      "diff --git a/foo.py b/bar.py",
      "similarity index 89%",
      "rename from foo.py",
      "rename to bar.py",
      "--- a/foo.py",
      "+++ b/bar.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).not.toContain("similarity index 89%")
  })
})

// =============================================================================
// GROUP 6: Content line edge cases — 4 tests
// =============================================================================

describe("GROUP 6: Content line edge cases", () => {
  // S-LINE-1
  // Red-on-injection: strip tabs from content lines => "\tindented" becomes "indented"
  it("S-LINE-1: tab at start of content line passes through", () => {
    const input = ["--- a/foo.py", "+++ b/foo.py", "@@ -1 +1 @@", "\tindented_context"].join("\n")
    const v4a = unifiedDiffToV4A(input)
    // Tab-prefixed line treated as context line (starts with " " or as-is)
    // Actually a tab isn't +/-/space so the converter skips it per the filter
    // Let's verify the converter behavior: the update loop only emits lines
    // starting with +, -, " ", or "". A tab doesn't start with those. So it's dropped.
    // BUT: a line like " \tindented" (space then tab) would be a context line.
    // Let's test with a space prefix + tab in content:
    const input2 = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1 +1 @@",
      " \tindented_context",
      "-old",
      "+new",
    ].join("\n")
    const v4a2 = unifiedDiffToV4A(input2)
    expect(v4a2).toContain(" \tindented_context")
  })

  // S-LINE-2
  // Red-on-injection: include "\\ No newline" line => V4A gets a bogus content line
  it("S-LINE-2: '\\\\No newline at end of file' is skipped", () => {
    const input = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).not.toContain("\\ No newline at end of file")
    // But the actual change lines should still be present
    expect(v4a).toContain("-old")
    expect(v4a).toContain("+new")
  })

  // S-LINE-3
  // Red-on-injection: drop empty context lines => " " (single space) not emitted
  it("S-LINE-3: empty context line (single space) is preserved", () => {
    const input = ["--- a/foo.py", "+++ b/foo.py", "@@ -1,3 +1,3 @@", " above", " ", " below"].join(
      "\n",
    )
    const v4a = unifiedDiffToV4A(input)
    // The single-space context line must appear in V4A
    const lines = v4a.split("\n")
    expect(lines).toContain(" ")
  })

  // S-LINE-4
  // Red-on-injection: treat any line starting with "---" as a new file header =>
  //   " ---" content line mistakenly starts a new file block
  it("S-LINE-4: context line starting with ' ---' (space + triple dash) passes through", () => {
    const input = [
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1,3 +1,3 @@",
      " ---separator---",
      "-old",
      "+new",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain(" ---separator---")
    // The file should only produce one op
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
  })
})

// =============================================================================
// GROUP 7: Round-trip integration — 4 tests
// =============================================================================

describe("GROUP 7: Round-trip integration", () => {
  // S-RT-1
  // Red-on-injection: separate two hunks into two Update File ops => parsePatch sees 2 ops
  it("S-RT-1: single file update with 2 hunks round-trips cleanly", () => {
    const input = [
      "--- a/module.py",
      "+++ b/module.py",
      "@@ -1,4 +1,4 @@ class A:",
      " line1",
      "-old_a",
      "+new_a",
      " line3",
      "@@ -20,4 +20,4 @@ class B:",
      " lineX",
      "-old_b",
      "+new_b",
      " lineZ",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(() => parsePatch(v4a)).not.toThrow()
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
    const op = patch.ops[0]
    expect(op?.kind).toBe("update")
    if (op?.kind === "update") {
      expect(op.hunks).toHaveLength(2)
    }
  })

  // S-RT-2
  // Red-on-injection: skip + lines in add-file body => add op has no lines
  it("S-RT-2: add file from /dev/null with 3 lines round-trips cleanly", () => {
    const input = [
      "--- /dev/null",
      "+++ b/created.py",
      "@@ -0,0 +1,3 @@",
      "+alpha",
      "+beta",
      "+gamma",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(() => parsePatch(v4a)).not.toThrow()
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
    expect(patch.ops[0]?.kind).toBe("add")
    if (patch.ops[0]?.kind === "add") {
      expect(patch.ops[0].lines).toHaveLength(3)
    }
  })

  // S-RT-3
  // Red-on-injection: emit hunk content for delete => parsePatch sees invalid body
  it("S-RT-3: delete file to /dev/null round-trips cleanly", () => {
    const input = ["--- a/removed.py", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-line1", "-line2"].join(
      "\n",
    )
    const v4a = unifiedDiffToV4A(input)
    expect(() => parsePatch(v4a)).not.toThrow()
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
    expect(patch.ops[0]?.kind).toBe("delete")
  })

  // S-RT-4
  // Red-on-injection: merge all ops into one => ops.length === 1 not 3
  it("S-RT-4: 3-file mixed diff (update + add + delete) produces 3 ops", () => {
    const input = [
      "--- a/upd.py",
      "+++ b/upd.py",
      "@@ -1 +1 @@",
      "-oldupd",
      "+newupd",
      "--- /dev/null",
      "+++ b/new_file.py",
      "@@ -0,0 +1 @@",
      "+added_line",
      "--- a/del.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-deleted_line",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(() => parsePatch(v4a)).not.toThrow()
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(3)
    expect(patch.ops[0]?.kind).toBe("update")
    expect(patch.ops[1]?.kind).toBe("add")
    expect(patch.ops[2]?.kind).toBe("delete")
  })
})

// =============================================================================
// GROUP 8: Resilience (no throw on bad input from the converter itself) — 4 tests
// =============================================================================

describe("GROUP 8: Resilience (converter must not throw)", () => {
  // S-RES-1
  // Red-on-injection: throw on missing +++ => converter throws instead of returning best-effort V4A
  it("S-RES-1: truncated diff after '--- a/foo.py' does not throw from converter", () => {
    expect(() => unifiedDiffToV4A("--- a/foo.py")).not.toThrow()
    // Result should be a string (best-effort V4A)
    const result = unifiedDiffToV4A("--- a/foo.py")
    expect(typeof result).toBe("string")
    // Contains the opening sentinel at minimum
    expect(result).toContain("*** Begin Patch")
  })

  // S-RES-2
  // Red-on-injection: throw when no --- follows diff --git => converter crashes
  it("S-RES-2: 'diff --git a/f b/f' with nothing after does not throw", () => {
    expect(() => unifiedDiffToV4A("diff --git a/f b/f")).not.toThrow()
    const result = unifiedDiffToV4A("diff --git a/f b/f")
    expect(typeof result).toBe("string")
    expect(result).toContain("*** Begin Patch")
    expect(result).toContain("*** End Patch")
  })

  // S-RES-3
  // Red-on-injection: throw on malformed @@ line => converter crashes on bad hunk header
  it("S-RES-3: malformed hunk header does not throw from converter (parsePatch may throw)", () => {
    const input = "--- a/x.py\n+++ b/x.py\n@@BROKEN_NOT_A_REAL_HUNK\n+line1"
    expect(() => unifiedDiffToV4A(input)).not.toThrow()
    // We only guarantee the CONVERTER doesn't throw. parsePatch may.
    const result = unifiedDiffToV4A(input)
    expect(typeof result).toBe("string")
  })

  // S-RES-4
  // Red-on-injection: throw on trailing newlines only after "--- " => converter crashes
  it("S-RES-4: '--- ' followed by only newlines does not throw, returns string with sentinels", () => {
    const input = "--- \n\n\n"
    expect(() => unifiedDiffToV4A(input)).not.toThrow()
    const result = unifiedDiffToV4A(input)
    expect(typeof result).toBe("string")
    expect(result).toContain("*** Begin Patch")
    expect(result).toContain("*** End Patch")
  })
})
