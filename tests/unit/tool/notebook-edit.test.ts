/**
 * W6 — `notebook_edit` cell-edit core (closes the P17 / §16.5 NotebookEdit
 * defer: quanta READ .ipynb (ADR-0481) but could not EDIT). Pure, deterministic,
 * NEVER-throws nbformat cell editor: str_replace within a cell / insert a cell /
 * delete a cell. Preserves every other cell + notebook-level metadata; a
 * malformed notebook or a missing/ambiguous match returns a typed `{ok:false}`,
 * never a throw. Major-case TDD (the cell-edit logic is the heart of the tool).
 */
import { describe, expect, test } from "bun:test"
import { editNotebook } from "@/tool/notebook-edit"

const nb = (cells: unknown[]): string =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3" } },
    cells,
  })
const codeCell = (src: string, id = "c1") => ({
  cell_type: "code",
  id,
  source: src.split(/(?<=\n)/),
  metadata: {},
  execution_count: null,
  outputs: [],
})
const mdCell = (src: string, id = "m1") => ({
  cell_type: "markdown",
  id,
  source: src.split(/(?<=\n)/),
  metadata: {},
})

const parse = (json: string) =>
  JSON.parse(json) as { cells: { cell_type: string; source: unknown }[] }
const cellText = (c: { source: unknown }): string =>
  typeof c.source === "string" ? c.source : (c.source as string[]).join("")

describe("editNotebook — str_replace within a cell", () => {
  test("replaces a unique match in the targeted cell; other cells untouched", () => {
    const src = nb([codeCell("x = 1\nprint(x)\n", "a"), codeCell("y = 2\n", "b")])
    const r = editNotebook(src, { kind: "str_replace", cell: 0, oldStr: "x = 1", newStr: "x = 42" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = parse(r.json)
    expect(cellText(out.cells[0]!)).toBe("x = 42\nprint(x)\n")
    expect(cellText(out.cells[1]!)).toBe("y = 2\n") // sibling intact
    expect(out.cells).toHaveLength(2)
  })

  test("ambiguous match (>1) without replaceAll ⇒ typed error (no silent partial)", () => {
    const r = editNotebook(nb([codeCell("a\na\n")]), {
      kind: "str_replace",
      cell: 0,
      oldStr: "a",
      newStr: "b",
    })
    expect(r.ok).toBe(false)
  })

  test("replaceAll ⇒ all occurrences in the cell replaced", () => {
    const r = editNotebook(nb([codeCell("a\na\n")]), {
      kind: "str_replace",
      cell: 0,
      oldStr: "a",
      newStr: "b",
      replaceAll: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(cellText(parse(r.json).cells[0]!)).toBe("b\nb\n")
  })

  test("match not found ⇒ typed error", () => {
    expect(
      editNotebook(nb([codeCell("x\n")]), {
        kind: "str_replace",
        cell: 0,
        oldStr: "zzz",
        newStr: "q",
      }).ok,
    ).toBe(false)
  })

  test("cell index out of range ⇒ typed error", () => {
    expect(
      editNotebook(nb([codeCell("x\n")]), {
        kind: "str_replace",
        cell: 9,
        oldStr: "x",
        newStr: "y",
      }).ok,
    ).toBe(false)
  })
})

describe("editNotebook — insert / delete", () => {
  test("insert a code cell at an index; length+content correct, others preserved", () => {
    const src = nb([codeCell("first\n", "a"), codeCell("second\n", "b")])
    const r = editNotebook(src, { kind: "insert", index: 1, cellType: "code", source: "middle\n" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = parse(r.json)
    expect(out.cells).toHaveLength(3)
    expect(cellText(out.cells[1]!)).toBe("middle\n")
    expect(out.cells[1]!.cell_type).toBe("code")
    expect(cellText(out.cells[2]!)).toBe("second\n")
  })

  test("insert at end (index = length) appends", () => {
    const r = editNotebook(nb([mdCell("# title\n")]), {
      kind: "insert",
      index: 1,
      cellType: "markdown",
      source: "tail\n",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(parse(r.json).cells).toHaveLength(2)
  })

  test("delete removes the targeted cell; others shift", () => {
    const src = nb([codeCell("a\n", "a"), codeCell("b\n", "b"), codeCell("c\n", "c")])
    const r = editNotebook(src, { kind: "delete", cell: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = parse(r.json)
    expect(out.cells).toHaveLength(2)
    expect(out.cells.map((c) => cellText(c))).toEqual(["a\n", "c\n"])
  })

  test("delete out-of-range ⇒ typed error", () => {
    expect(editNotebook(nb([codeCell("a\n")]), { kind: "delete", cell: 5 }).ok).toBe(false)
  })
})

describe("editNotebook — NEVER throws on malformed input", () => {
  test("non-JSON ⇒ typed error", () => {
    expect(editNotebook("{ this is not json", { kind: "delete", cell: 0 }).ok).toBe(false)
  })
  test("JSON but not a notebook (no cells array) ⇒ typed error", () => {
    expect(editNotebook('{"foo":1}', { kind: "delete", cell: 0 }).ok).toBe(false)
  })
  test("preserves notebook-level metadata + nbformat version", () => {
    const r = editNotebook(nb([codeCell("x\n")]), {
      kind: "insert",
      index: 0,
      cellType: "code",
      source: "y\n",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = JSON.parse(r.json) as {
      nbformat: number
      metadata: { kernelspec: { name: string } }
    }
    expect(out.nbformat).toBe(4)
    expect(out.metadata.kernelspec.name).toBe("python3")
  })
})
