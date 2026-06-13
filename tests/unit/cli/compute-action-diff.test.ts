/**
 * T05 — structured `(path, before, after)` extraction from a ToolAction, the
 * bridge between the diff preview the operator sees and the partial-apply
 * executor. File reads are injected (no real FS). Asserts by VALUE: the derived
 * `before`/`after` must be the exact strings the hunk math will diff.
 */
import { describe, expect, it } from "bun:test"
import { computeActionDiff } from "../../../src/apps/cli/diff-preview"
import type { ToolAction } from "../../../src/permission"

const action = (tool: string, input: unknown): ToolAction => ({
  tool,
  input,
  isReadOnly: false,
  shellCommand: null,
})

const reader = (content: string | null) => async (_p: string) => {
  if (content === null) throw new Error("ENOENT")
  return content
}

describe("computeActionDiff", () => {
  it("write: before = existing file, after = content", async () => {
    const got = await computeActionDiff(action("write", { path: "/f", content: "a\nB\nc" }), {
      readFile: reader("a\nb\nc"),
    })
    expect(got).toEqual({ path: "/f", before: "a\nb\nc", after: "a\nB\nc" })
  })

  it("write: new file → before is empty", async () => {
    const got = await computeActionDiff(action("write", { path: "/f", content: "x" }), {
      readFile: reader(null),
    })
    expect(got).toEqual({ path: "/f", before: "", after: "x" })
  })

  it("edit: derives full-file before/after by applying the fragment swap", async () => {
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "b", new_string: "B" }),
      { readFile: reader("a\nb\nc") },
    )
    expect(got).toEqual({ path: "/f", before: "a\nb\nc", after: "a\nB\nc" })
  })

  it("edit: replace_all swaps every occurrence", async () => {
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "x", new_string: "Y", replace_all: true }),
      { readFile: reader("x\nx\nz") },
    )
    expect(got?.after).toBe("Y\nY\nz")
  })

  it("edit: fuzzy=true → undefined (preview must not diverge from the tool's matcher)", async () => {
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "b", new_string: "B", fuzzy: true }),
      { readFile: reader("a\nb\nc") },
    )
    expect(got).toBeUndefined()
  })

  it("edit: line_ranges present → undefined (windowed match, not literal)", async () => {
    const got = await computeActionDiff(
      action("edit", {
        path: "/f",
        old_string: "b",
        new_string: "B",
        line_ranges: [{ start: 1, end: 2 }],
      }),
      { readFile: reader("a\nb\nc") },
    )
    expect(got).toBeUndefined()
  })

  it("edit: NON-UNIQUE old_string with replace_all unset → undefined (tool would be ambiguous)", async () => {
    // The edit tool's exact tier requires a UNIQUE match unless replace_all; a
    // non-unique old_string is `ambiguous` (errors, no write). A literal replaceFirst
    // preview would silently apply the FIRST occurrence — a divergence. Refuse it.
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "x", new_string: "Y" }),
      { readFile: reader("x\na\nx") },
    )
    expect(got).toBeUndefined()
  })

  it("edit: non-unique old_string WITH replace_all=true is fine (swaps all)", async () => {
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "x", new_string: "Y", replace_all: true }),
      { readFile: reader("x\na\nx") },
    )
    expect(got?.after).toBe("Y\na\nY")
  })

  it("edit: UNIQUE old_string, replace_all unset → still works (the safe common case)", async () => {
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "b", new_string: "B" }),
      { readFile: reader("a\nb\nc") },
    )
    expect(got).toEqual({ path: "/f", before: "a\nb\nc", after: "a\nB\nc" })
  })

  it("edit: old_string not found → undefined (whole-call fallback)", async () => {
    const got = await computeActionDiff(
      action("edit", { path: "/f", old_string: "absent", new_string: "Z" }),
      { readFile: reader("a\nb\nc") },
    )
    expect(got).toBeUndefined()
  })

  it("scripted_replace: before = file, after = regex-applied result", async () => {
    const got = await computeActionDiff(
      action("scripted_replace", {
        file: "/f",
        pattern: "foo",
        replacement: "bar",
        isRegex: false,
      }),
      { readFile: reader("foo\nbaz\nfoo") },
    )
    expect(got).toEqual({ path: "/f", before: "foo\nbaz\nfoo", after: "bar\nbaz\nbar" })
  })

  it("scripted_replace: isRegex=true applies the regex (distinct from literal)", async () => {
    const got = await computeActionDiff(
      action("scripted_replace", {
        file: "/f",
        pattern: "\\d+",
        replacement: "N",
        isRegex: true,
      }),
      { readFile: reader("foo123\nbar456") },
    )
    expect(got?.after).toBe("fooN\nbarN")
  })

  it("scripted_replace: count cap limits replacements", async () => {
    const got = await computeActionDiff(
      action("scripted_replace", {
        file: "/f",
        pattern: "x",
        replacement: "Y",
        isRegex: false,
        count: 2,
      }),
      { readFile: reader("x\nx\nx\nx") },
    )
    // Only the first 2 of 4 occurrences swapped.
    expect(got?.after).toBe("Y\nY\nx\nx")
  })

  it("scripted_replace: no match → undefined", async () => {
    const got = await computeActionDiff(
      action("scripted_replace", { file: "/f", pattern: "zzz", replacement: "q" }),
      { readFile: reader("aaa") },
    )
    expect(got).toBeUndefined()
  })

  it("apply_patch is not decomposable into before/after here → undefined", async () => {
    const got = await computeActionDiff(
      action("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }),
      { readFile: reader("x") },
    )
    expect(got).toBeUndefined()
  })

  it("unsupported tool → undefined", async () => {
    const got = await computeActionDiff(action("bash", { command: "ls" }), {
      readFile: reader("x"),
    })
    expect(got).toBeUndefined()
  })
})
