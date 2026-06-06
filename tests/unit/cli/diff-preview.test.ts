import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_CONTEXT_LINES,
  diffPreviewEnabled,
  renderActionDiff,
  renderUnified,
  resolveEnvCaps,
} from "../../../src/apps/cli/diff-preview"
import type { ToolAction } from "../../../src/permission"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

/**
 * Tests for the inline confirm-prompt diff preview.
 *
 * Strategy:
 *   - Pin colour mode ON for the suite so ANSI escapes are deterministic,
 *     then `stripAnsi` for content assertions (mirrors the auth-ui test
 *     pattern in tests/unit/ui).
 *   - File reads are injected via `opts.readFile` so the suite never
 *     touches the real filesystem — covers the "missing file" path
 *     without race-prone tempdir mgmt.
 *
 * Coverage matrix matches the four supported tools (write/edit/apply_patch/
 * scripted_replace) plus the graceful-fallback paths (missing input keys,
 * binary content, oversize, read-failure, unsupported tool, ENV knobs).
 */

const action = (tool: string, input: unknown): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
  shellCommand: null,
})

/** Assert the preview rendered + return the string. Avoids the forbidden
 *  `noNonNullAssertion` warning every `stripAnsi(out!)` callsite would
 *  trigger; codebase convention prefers a narrowing helper. */
const mustRender = (out: string | undefined): string => {
  expect(out).toBeDefined()
  if (out === undefined) throw new Error("unreachable: previous expect guards")
  return out
}

beforeEach(() => {
  setColorPolicy("on") // force ANSI so escape assertions are deterministic
})

afterEach(() => {
  setColorPolicy(null)
  delete process.env.QUANTA_DIFF_PREVIEW
  delete process.env.QUANTA_DIFF_MAX_BYTES
  delete process.env.QUANTA_DIFF_MAX_LINES
})

describe("renderActionDiff — write", () => {
  test("new file (read miss) renders + lines with 'new file' note", async () => {
    const out = await renderActionDiff(
      action("write", { path: "/x/new.ts", content: "line A\nline B" }),
      {
        readFile: async () => {
          throw new Error("ENOENT")
        },
      },
    )
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("/x/new.ts")
    expect(plain).toContain("(new file)")
    expect(plain).toContain("+ line A")
    expect(plain).toContain("+ line B")
  })

  test("existing file → diff with + and - lines", async () => {
    const out = await renderActionDiff(action("write", { path: "/x/f.ts", content: "kept\nNEW" }), {
      readFile: async () => "kept\nOLD",
    })
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("- OLD")
    expect(plain).toContain("+ NEW")
    expect(plain).toContain("  kept")
  })

  test("contains ANSI escapes when colour ON", async () => {
    const out = await renderActionDiff(action("write", { path: "/x/f.ts", content: "B" }), {
      readFile: async () => "A",
    })
    const rendered = mustRender(out)
    // ESC byte present somewhere in the rendered output.
    expect(rendered.includes(String.fromCharCode(27))).toBe(true)
  })
})

describe("renderActionDiff — edit", () => {
  test("renders fragment swap (- old / + new) without touching fs", async () => {
    const out = await renderActionDiff(
      action("edit", { path: "/x/e.ts", old_string: "foo\nbar", new_string: "baz" }),
    )
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("/x/e.ts")
    expect(plain).toContain("- foo")
    expect(plain).toContain("- bar")
    expect(plain).toContain("+ baz")
  })

  test("missing required keys → undefined (graceful)", async () => {
    const out = await renderActionDiff(action("edit", { path: "/x/e.ts" }))
    expect(out).toBeUndefined()
  })
})

describe("renderActionDiff — apply_patch", () => {
  test("passthrough V4A patch with +/- colourisation", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /x/f.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    const out = await renderActionDiff(action("apply_patch", { patch }))
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("*** Begin Patch")
    expect(plain).toContain("*** Update File: /x/f.ts")
    expect(plain).toContain("-old")
    expect(plain).toContain("+new")
  })
})

describe("renderActionDiff — scripted_replace", () => {
  test("preview applies literal substitution against existing file", async () => {
    const out = await renderActionDiff(
      action("scripted_replace", { file: "/x/s.ts", pattern: "foo", replacement: "FOO" }),
      { readFile: async () => "a foo b\nfoo line" },
    )
    const plain = stripAnsi(mustRender(out))
    expect(plain).toContain("- a foo b")
    expect(plain).toContain("+ a FOO b")
  })

  test("invalid regex → graceful 'invalid regex' notice", async () => {
    const out = await renderActionDiff(
      action("scripted_replace", {
        file: "/x/s.ts",
        pattern: "([",
        replacement: "X",
        isRegex: true,
      }),
      { readFile: async () => "anything" },
    )
    expect(stripAnsi(mustRender(out))).toContain("[invalid regex; preview skipped]")
  })

  test("missing file → graceful 'file not found' notice", async () => {
    const out = await renderActionDiff(
      action("scripted_replace", { file: "/x/s.ts", pattern: "foo", replacement: "bar" }),
      {
        readFile: async () => {
          throw new Error("ENOENT")
        },
      },
    )
    expect(stripAnsi(mustRender(out))).toContain("[file not found; preview skipped]")
  })
})

describe("renderActionDiff — fallback / caps", () => {
  test("unknown tool → undefined", async () => {
    const out = await renderActionDiff(action("bash", { command: "ls" }))
    expect(out).toBeUndefined()
  })

  // asRecord array-handling safety: an array IS `typeof "object"` and
  // not null, so a naive narrower would let it through as a "record" and
  // then read `.path` / `.content` off it (undefined) — a latent bug. The
  // `!Array.isArray` guard makes the array collapse to "no preview".
  test("write with array input → no preview (array is not a record)", async () => {
    const out = await renderActionDiff(action("write", [{ path: "/x/f", content: "hi" }]), {
      readFile: async () => "",
    })
    expect(out).toBeUndefined()
  })

  test("write with a normal object input still renders", async () => {
    const out = await renderActionDiff(action("write", { path: "/x/f", content: "hi" }), {
      readFile: async () => "",
    })
    expect(out).toBeDefined()
  })

  test("write of binary content (NUL byte) → preview skipped", async () => {
    const out = await renderActionDiff(
      action("write", { path: "/x/bin", content: `head${String.fromCharCode(0)}tail` }),
      { readFile: async () => "" },
    )
    expect(stripAnsi(mustRender(out))).toContain("too large or binary")
  })

  test("oversize content (> maxBytes) → preview skipped", async () => {
    const out = await renderActionDiff(
      action("write", { path: "/x/big", content: "x".repeat(2000) }),
      { readFile: async () => "", maxBytes: 100 },
    )
    expect(stripAnsi(mustRender(out))).toContain("too large or binary")
  })

  test("diff clipped at maxLines with '… N more' suffix", async () => {
    const before = ""
    const after = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const out = await renderActionDiff(action("write", { path: "/x/f", content: after }), {
      readFile: async () => before,
      maxLines: 10,
    })
    const plain = stripAnsi(mustRender(out))
    expect(plain).toMatch(/… \(\d+ more lines?\)/)
    // 10 visible diff lines + 1 header line + 1 clip line = 12 newlines (11 \n).
    expect(plain.split("\n").length).toBe(12)
  })
})

describe("renderUnified — direct LCS coverage", () => {
  test("empty → empty produces empty body", () => {
    expect(renderUnified("", "", 100)).toBe("")
  })

  test("keep lines rendered with two-space prefix", () => {
    const out = stripAnsi(renderUnified("same", "same", 100))
    expect(out).toBe("  same")
  })

  test("interleaved keep / del / add ordering", () => {
    const out = stripAnsi(renderUnified("a\nb\nc", "a\nB\nc", 100))
    expect(out.split("\n")).toEqual(["  a", "- b", "+ B", "  c"])
  })
})

describe("renderUnified — hunk-aware path (@@ headers + line-number gutters)", () => {
  // Helper: build N old lines.
  const lines = (n: number, label = "L"): string =>
    Array.from({ length: n }, (_, i) => `${label}${i + 1}`).join("\n")

  test("option OFF is byte-identical to the simple path (regression anchor)", () => {
    const before = "a\nb\nc"
    const after = "a\nB\nc"
    // No opts, explicit {hunks:false}, and the legacy 3-arg form must all match.
    const simple = renderUnified(before, after, 100)
    expect(renderUnified(before, after, 100, {})).toBe(simple)
    expect(renderUnified(before, after, 100, { hunks: false })).toBe(simple)
    // And the simple body is the documented +/- form (no gutters, no @@).
    expect(stripAnsi(simple).split("\n")).toEqual(["  a", "- b", "+ B", "  c"])
  })

  test("DEFAULT_CONTEXT_LINES is git's 3", () => {
    expect(DEFAULT_CONTEXT_LINES).toBe(3)
  })

  test("all-keep diff (no change) renders zero hunks → empty body", () => {
    const same = lines(20)
    expect(renderUnified(same, same, 100, { hunks: true })).toBe("")
  })

  test("single hunk: @@ header counts span change + context", () => {
    // 10 lines, change line 5. context 3 → hunk spans old lines 2..8 (7 lines).
    const before = lines(10)
    const after = before.replace("L5", "X5")
    const out = stripAnsi(renderUnified(before, after, 200, { hunks: true, context: 3 }))
    const rows = out.split("\n")
    // header: lines 2..8 on old = 7, on new the changed line splits to del+add
    // so old has 7 (2..8), new has 7 (2..8). Both starts = 2.
    expect(rows[0]).toBe("@@ -2,7 +2,7 @@")
    // del L5 then add X5; surrounding keeps carry both numbers.
    expect(out).toContain("- L5")
    expect(out).toContain("+ X5")
    // The hunk omits lines 1 and 9,10 (outside context).
    expect(out).not.toContain("L1")
    expect(out).not.toContain("L9")
    expect(out).not.toContain("L10")
  })

  test("line-number gutters advance: del→old++, add→new++, keep→both++", () => {
    // before: a b c   after: a B c  → keep a(1,1), del b(old2), add B(new2), keep c(3,3)
    const out = stripAnsi(renderUnified("a\nb\nc", "a\nB\nc", 100, { hunks: true }))
    const rows = out.split("\n").slice(1) // drop @@ header
    // width is 1 (max line no = 3). gutter = "old new  marker line"
    // gutter = `${oldG} ${newG} ` (w=1) then `${marker} ${line}`.
    // del → newG is one blank → "2" + " " + " " + " " + "- b" = "2   - b".
    expect(rows).toEqual([
      "1 1   a", // keep: old1 new1
      "2   - b", // del: old2, new blank
      "  2 + B", // add: old blank, new2
      "3 3   c", // keep: old3 new3
    ])
  })

  test("right-alignment to max width on a >=1000-line file", () => {
    // 1005 lines; change line 1003. Max line no is 1005 → width 4.
    const before = lines(1005)
    const after = before.replace("L1003", "X1003")
    const out = stripAnsi(renderUnified(before, after, 500, { hunks: true, context: 2 }))
    const rows = out.split("\n")
    expect(rows[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    // every gutter pair right-aligned to 4: "1001 1001   L1001"
    const keepRow = rows.find((r) => r.includes("L1001"))
    expect(keepRow).toBe("1001 1001   L1001")
    const delRow = rows.find((r) => r.includes("- L1003"))
    // old gutter "1003" width 4, new gutter blank width 4
    expect(delRow).toBe("1003      - L1003")
  })

  test("two changes far apart (gap > 2*context) → TWO separate hunks", () => {
    // 30 lines, change line 3 and line 27. context 3 → gap (4..26) = 23 > 6.
    const before = lines(30)
    const after = before.replace("L3", "X3").replace("L27", "X27")
    const out = stripAnsi(renderUnified(before, after, 500, { hunks: true, context: 3 }))
    const headers = out.split("\n").filter((r) => r.startsWith("@@"))
    expect(headers.length).toBe(2)
    // First hunk near top, second near bottom; both well-formed.
    expect(headers[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    expect(headers[1]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
  })

  test("two changes close together (gap <= 2*context) → ONE merged hunk", () => {
    // change line 5 and line 10; gap (6..9) = 4 <= 2*3=6 → merge.
    const before = lines(20)
    const after = before.replace("L5", "X5").replace("L10", "X10")
    const out = stripAnsi(renderUnified(before, after, 500, { hunks: true, context: 3 }))
    const headers = out.split("\n").filter((r) => r.startsWith("@@"))
    expect(headers.length).toBe(1)
    // merged hunk must contain BOTH changes and the bridging context lines.
    expect(out).toContain("- L5")
    expect(out).toContain("- L10")
    expect(out).toContain("L7") // bridging context kept
  })

  test("gap exactly 2*context+1 splits; exactly 2*context merges (boundary)", () => {
    const ctx = 2
    // changes at indices i and j; unchanged between = j-i-1.
    // MERGE boundary: between = 2*ctx = 4.  change line 3 and line 8 → between=4.
    const mergeBefore = lines(20)
    const mergeAfter = mergeBefore.replace("L3", "Y3").replace("L8", "Y8")
    const mergeOut = stripAnsi(
      renderUnified(mergeBefore, mergeAfter, 500, { hunks: true, context: ctx }),
    )
    expect(mergeOut.split("\n").filter((r) => r.startsWith("@@")).length).toBe(1)
    // SPLIT boundary: between = 2*ctx+1 = 5. change line 3 and line 9 → between=5.
    const splitBefore = lines(20)
    const splitAfter = splitBefore.replace("L3", "Y3").replace("L9", "Y9")
    const splitOut = stripAnsi(
      renderUnified(splitBefore, splitAfter, 500, { hunks: true, context: ctx }),
    )
    expect(splitOut.split("\n").filter((r) => r.startsWith("@@")).length).toBe(2)
  })

  test("pure addition into empty file: old side count 0, start 0", () => {
    const out = stripAnsi(renderUnified("", "n1\nn2", 100, { hunks: true }))
    const rows = out.split("\n")
    // git renders @@ -0,0 +1,2 @@ for an all-add into empty.
    expect(rows[0]).toBe("@@ -0,0 +1,2 @@")
    expect(rows[1]).toContain("+ n1")
    expect(rows[2]).toContain("+ n2")
  })

  test("pure deletion to empty file: new side count 0, start 0", () => {
    const out = stripAnsi(renderUnified("o1\no2", "", 100, { hunks: true }))
    const rows = out.split("\n")
    expect(rows[0]).toBe("@@ -1,2 +0,0 @@")
    expect(rows[1]).toContain("- o1")
    expect(rows[2]).toContain("- o2")
  })

  test("single-line file change reports real 1-based starts", () => {
    const out = stripAnsi(renderUnified("only", "ONLY", 100, { hunks: true }))
    const rows = out.split("\n")
    expect(rows[0]).toBe("@@ -1,1 +1,1 @@")
    expect(out).toContain("- only")
    expect(out).toContain("+ ONLY")
  })

  test("hunk body respects maxLines clip", () => {
    const before = lines(40)
    const after = Array.from({ length: 40 }, (_, i) => `X${i + 1}`).join("\n")
    const out = stripAnsi(renderUnified(before, after, 5, { hunks: true }))
    expect(out).toMatch(/… \(\d+ more lines?\)/)
  })

  test("clip never leaves an orphan @@ header (no body after the cut)", () => {
    // Two well-separated hunks. A cut landing right after a header must drop
    // that orphan header too — a unified-diff header with zero body rows is
    // malformed (downstream patch parsers reject it). Sweep every maxLines.
    const arr = lines(20).split("\n")
    arr[1] = "CHANGED_A" // hunk 1 (around line 2)
    arr[17] = "CHANGED_B" // hunk 2 (around line 18) — separated by >2*context
    const before = lines(20)
    const after = arr.join("\n")
    for (let mx = 1; mx <= 25; mx += 1) {
      const out = stripAnsi(renderUnified(before, after, mx, { hunks: true }))
      const rows = out.split("\n").filter((r) => !r.startsWith("… ("))
      const last = rows[rows.length - 1] ?? ""
      expect(last.startsWith("@@")).toBe(false)
    }
  })

  test("hunk path emits ANSI colour for changed lines", () => {
    const rendered = renderUnified("a\nb", "a\nB", 100, { hunks: true })
    expect(rendered.includes(String.fromCharCode(27))).toBe(true)
  })
})

describe("ENV knobs", () => {
  test("diffPreviewEnabled: explicit '0' disables even on TTY", () => {
    process.env.QUANTA_DIFF_PREVIEW = "0"
    expect(diffPreviewEnabled()).toBe(false)
  })

  test("diffPreviewEnabled: explicit '1' enables even off TTY", () => {
    process.env.QUANTA_DIFF_PREVIEW = "1"
    expect(diffPreviewEnabled()).toBe(true)
  })

  test("resolveEnvCaps reads QUANTA_DIFF_MAX_BYTES / _LINES at call time", () => {
    process.env.QUANTA_DIFF_MAX_BYTES = "1234"
    process.env.QUANTA_DIFF_MAX_LINES = "7"
    expect(resolveEnvCaps()).toEqual({ maxBytes: 1234, maxLines: 7 })
  })

  test("resolveEnvCaps falls back to defaults for invalid values", () => {
    process.env.QUANTA_DIFF_MAX_BYTES = "garbage"
    process.env.QUANTA_DIFF_MAX_LINES = "-5"
    const caps = resolveEnvCaps()
    expect(caps.maxBytes).toBeGreaterThan(0)
    expect(caps.maxLines).toBeGreaterThan(0)
  })
})
