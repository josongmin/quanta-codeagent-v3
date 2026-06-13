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
