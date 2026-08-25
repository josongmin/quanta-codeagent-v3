/**
 * W6 — `notebook_edit` pure cell editor (closes the P17 / §16.5 NotebookEdit
 * defer). quanta READS `.ipynb` (ADR-0481 cell-aware render); this adds the
 * EDIT half: str_replace within a cell / insert a cell / delete a cell, on the
 * nbformat JSON, preserving every other cell + notebook-level metadata.
 *
 * PURE + NEVER-throws: a malformed notebook, a missing/ambiguous match, or an
 * out-of-range index returns a typed `{ ok:false, reason }` — the tool wrapper
 * turns that into a normal `is_error` tool_result, never a crash. The wrapper
 * (default-OFF `QUANTA_NOTEBOOK_EDIT`) reads/writes the file through the SAME
 * FS jail the readers use.
 */
import { errMessage } from "@/shared"

export type NotebookEditOp =
  | {
      readonly kind: "str_replace"
      readonly cell: number
      readonly oldStr: string
      readonly newStr: string
      readonly replaceAll?: boolean
    }
  | {
      readonly kind: "insert"
      readonly index: number
      readonly cellType: "code" | "markdown"
      readonly source: string
    }
  | { readonly kind: "delete"; readonly cell: number }

export type NotebookEditResult =
  | { readonly ok: true; readonly json: string; readonly summary: string }
  | { readonly ok: false; readonly reason: string }

interface NbCell {
  cell_type: string
  source: string | string[]
  metadata?: unknown
  id?: string
  execution_count?: number | null
  outputs?: unknown[]
}
interface Notebook {
  cells: NbCell[]
  [k: string]: unknown
}

/** nbformat `source` is `string | string[]` (array elements keep trailing `\n`);
 *  join to a single string. */
const joinSource = (source: string | string[]): string =>
  typeof source === "string" ? source : source.join("")

/** Split back into the nbformat array-of-lines convention (each line keeps its
 *  trailing `\n`; empty body ⇒ `[]`). Inverse of {@link joinSource}. */
const splitLines = (s: string): string[] => (s.length === 0 ? [] : s.split(/(?<=\n)/))

const fail = (reason: string): NotebookEditResult => ({ ok: false, reason })

/** The three op arms all needed a `Notebook` OR a typed reason; parsing +
 *  shape-validating is one unit so `editNotebook` holds no `try` of its own
 *  around the parse and the arms stop paying its nesting surcharge. The clone
 *  stays INSIDE the try (same catch tail as `JSON.parse`) and is shallow on
 *  purpose — the input object is never mutated, everything else is shared. */
type ParsedNotebook = { readonly nb: Notebook } | { readonly failure: string }
const parseNotebook = (rawJson: string): ParsedNotebook => {
  try {
    const parsed = JSON.parse(rawJson) as unknown
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Notebook).cells)
    ) {
      return { failure: "not a notebook: no `cells` array (nbformat expected)" }
    }
    // Work on a shallow clone of the cells array so the input is never mutated.
    return { nb: { ...(parsed as Notebook), cells: [...(parsed as Notebook).cells] } }
  } catch (e) {
    return { failure: `invalid notebook JSON: ${errMessage(e)}` }
  }
}

/** `str_replace` and `delete` address an EXISTING cell and spelled the identical
 *  half-open range check + message twice; one helper so the two arms cannot
 *  drift apart. Returns the failure, or `null` when the index is addressable. */
const cellOutOfRange = (cell: number, cellCount: number): NotebookEditResult | null =>
  cell < 0 || cell >= cellCount
    ? fail(`cell index ${cell} out of range (0..${cellCount - 1})`)
    : null

/** One unit per op arm: each owns its own preconditions and its own mutation of
 *  the already-cloned `nb`, so no arm can see another's locals and the shared
 *  try/catch tail lives once in {@link editNotebook}. */
const applyStrReplace = (
  nb: Notebook,
  op: Extract<NotebookEditOp, { kind: "str_replace" }>,
): NotebookEditResult => {
  const range = cellOutOfRange(op.cell, nb.cells.length)
  if (range !== null) return range
  if (op.oldStr.length === 0) return fail("str_replace: oldStr must be non-empty")
  const cell = nb.cells[op.cell] as NbCell
  const body = joinSource(cell.source)
  const occ = body.split(op.oldStr).length - 1
  if (occ === 0) return fail(`str_replace: oldStr not found in cell ${op.cell}`)
  if (occ > 1 && op.replaceAll !== true)
    return fail(
      `str_replace: oldStr matches ${occ}× in cell ${op.cell} — pass replaceAll or disambiguate`,
    )
  // `split/join` (replaceAll) is NOT `String.replace` (single): only the latter
  // expands `$&`/`$1` in the replacement. Kept exactly as-is — the two arms are
  // observably different and callers depend on the single-replace semantics.
  const next =
    op.replaceAll === true
      ? body.split(op.oldStr).join(op.newStr)
      : body.replace(op.oldStr, op.newStr)
  nb.cells[op.cell] = { ...cell, source: splitLines(next) }
  return ok(nb, `str_replace in cell ${op.cell} (${occ}×)`)
}

const applyInsert = (
  nb: Notebook,
  op: Extract<NotebookEditOp, { kind: "insert" }>,
): NotebookEditResult => {
  // INCLUSIVE upper bound (unlike the address-an-existing-cell ops): appending
  // at `cells.length` is legal, so this cannot share `cellOutOfRange`.
  if (op.index < 0 || op.index > nb.cells.length)
    return fail(`insert index ${op.index} out of range (0..${nb.cells.length})`)
  // nbformat 4.5 wants a cell `id`; we omit it (Jupyter regenerates a
  // missing id on load) rather than mint a non-deterministic one.
  const cell: NbCell =
    op.cellType === "code"
      ? {
          cell_type: "code",
          source: splitLines(op.source),
          metadata: {},
          execution_count: null,
          outputs: [],
        }
      : { cell_type: "markdown", source: splitLines(op.source), metadata: {} }
  nb.cells.splice(op.index, 0, cell)
  return ok(nb, `inserted ${op.cellType} cell at index ${op.index}`)
}

const applyDelete = (
  nb: Notebook,
  op: Extract<NotebookEditOp, { kind: "delete" }>,
): NotebookEditResult => {
  const range = cellOutOfRange(op.cell, nb.cells.length)
  if (range !== null) return range
  nb.cells.splice(op.cell, 1)
  return ok(nb, `deleted cell ${op.cell}`)
}

/** Edit one cell of an nbformat notebook. Pure; never throws. */
export const editNotebook = (rawJson: string, op: NotebookEditOp): NotebookEditResult => {
  const parsed = parseNotebook(rawJson)
  if ("failure" in parsed) return fail(parsed.failure)
  try {
    switch (op.kind) {
      case "str_replace":
        return applyStrReplace(parsed.nb, op)
      case "insert":
        return applyInsert(parsed.nb, op)
      case "delete":
        return applyDelete(parsed.nb, op)
      default:
        return fail("unknown notebook edit op")
    }
  } catch (e) {
    // The arms are hostile-input tolerant but not hostile-input PROOF (a cell
    // whose `source` is a number makes `joinSource` throw); the never-throws
    // contract is honoured here, once, for all of them.
    return fail(errMessage(e))
  }
}

/** Re-serialize with nbformat's canonical 1-space indent. */
const ok = (nb: Notebook, summary: string): NotebookEditResult => ({
  ok: true,
  json: JSON.stringify(nb, null, 1),
  summary,
})
