/**
 * jun-6 — cell-aware `.ipynb` render (ADR-0481).
 *
 * `read` today streams a `.ipynb` as raw nbformat JSON: array-of-strings
 * `source`, `execution_count`/`id`/`metadata` machinery, and — the expensive
 * part — `outputs[]` carrying **base64-encoded PNG/JPEG image payloads** that a
 * model never wants and that token-explode the transcript. This module is a
 * PURE transform that the read pipeline applies for `.ipynb` ONLY: parse
 * `cells[]`, emit each cell's source (line-numbered, cell index + type tagged),
 * append textual outputs, and STRIP every base64 image blob to a one-line
 * `«image output: …»` placeholder (never the blob itself).
 *
 * Invariants:
 *  - NO I/O, NO clock, NO randomness, NO `process.env` — string in, string out.
 *  - NEVER throws. A malformed / non-nbformat / truncated notebook ⇒ `null`, so
 *    the caller falls back to the raw text render (a corrupt notebook is still
 *    readable as JSON). A typed soft-fail, never a crash.
 *  - The base64 of an image output is NEVER emitted (token-explosion guard); we
 *    estimate its decoded byte length WITHOUT decoding (a huge blob is never
 *    materialized — that would be wasted work and a DoS vector).
 */

/** True iff the path's extension is `.ipynb` (case-insensitive). This is the
 *  ONLY gate that diverts a read away from the byte-identical raw path — every
 *  other extension is `false` here, so `read` returns unchanged content. */
export const isNotebook = (path: string): boolean => /\.ipynb$/i.test(path)

/** Hard cap on the number of cells rendered. A pathological notebook with tens
 *  of thousands of cells must not blow the budget (DoS guard): cells beyond
 *  this count are dropped and a one-line truncation notice is appended, so the
 *  render stays bounded while the model is told it is incomplete. `read`'s outer
 *  `offset`/`limit` still pages the (now bounded) document. */
export const MAX_NOTEBOOK_CELLS = 5000

/** Hard cap on the number of outputs rendered per cell. A single code cell
 *  with tens of thousands of `stream` outputs (e.g. a print loop) would
 *  produce an unbounded token blob even after the per-output char cap; this
 *  cap bounds the SUM of outputs per cell to a safe finite ceiling. */
export const MAX_OUTPUTS_PER_CELL = 64

export interface NotebookRenderOpts {
  /** Append each code cell's textual outputs (stream/text-plain/error). Base64
   *  image blobs are ALWAYS stripped regardless of this flag. */
  readonly includeOutputs: boolean
  /** Per-output character cap. A pathological multi-megabyte `stream` text or
   *  `text/plain` result is truncated to this many chars (mirrors the
   *  `capToolOutput` discipline — no unbounded emit). */
  readonly maxOutputChars: number
}

/** Estimate the DECODED byte length of a base64 string without decoding it.
 *  `len * 3 / 4` minus the `=` padding is the exact decoded size for valid
 *  base64; we never call `atob`/`Buffer.from` so a 50 MB blob costs O(1), not a
 *  full allocation. Bounded, pure, DoS-safe. */
const estimateBase64Bytes = (b64: string): number => {
  const len = b64.length
  if (len === 0) return 0
  let pad = 0
  if (b64.charCodeAt(len - 1) === 0x3d) pad++
  if (len > 1 && b64.charCodeAt(len - 2) === 0x3d) pad++
  return Math.max(0, Math.floor((len * 3) / 4) - pad)
}

/** Cap a string to `max` chars, appending a stable elision marker when it was
 *  actually truncated (so a model can tell a hard-capped output from a short
 *  one). `max <= 0` ⇒ empty (defensive; the caller passes a positive cap). */
const cap = (s: string, max: number): string => {
  if (max <= 0) return ""
  if (s.length <= max) return s
  return `${s.slice(0, max)}… (+${s.length - max} chars elided)`
}

/** nbformat `source` is `string | string[]`; join the array (each element is a
 *  line WITH its trailing `\n`, so a plain `.join("")` reconstitutes the cell).
 *  Anything else (number, object, missing) ⇒ empty string (fail-soft). */
const joinSource = (source: unknown): string => {
  if (typeof source === "string") return source
  if (Array.isArray(source)) {
    let out = ""
    for (const piece of source) if (typeof piece === "string") out += piece
    return out
  }
  return ""
}

/** nbformat output `text` (stream) is also `string | string[]`. */
const joinText = (text: unknown): string => joinSource(text)

/** Line-number a (already source-joined) cell body using the SAME `<n>\t<line>`
 *  convention `renderReadOk` uses for raw reads, so a notebook cell reads like
 *  any other file slice. Numbering is per-cell (1-based) — `read`'s outer
 *  offset/limit then pages the whole rendered document. */
const numberLines = (body: string): string => {
  // Trailing `\n` in a cell source would render a spurious final empty line;
  // drop exactly one to match how an editor shows the cell.
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body
  if (trimmed === "") return ""
  return trimmed
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n")
}

type JsonObject = Record<string, unknown>

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null

/** Render one output's `data` map: emit `text/plain` (capped) and replace every
 *  `image/*` MIME with a byte-estimated placeholder. The base64 value is read
 *  ONLY to estimate its length — it is NEVER copied into the output. */
const renderDataOutput = (data: JsonObject, opts: NotebookRenderOpts): string[] => {
  const lines: string[] = []
  for (const [mime, value] of Object.entries(data)) {
    if (mime.startsWith("image/")) {
      const b64 = typeof value === "string" ? value : joinSource(value)
      lines.push(`«image output: ${mime}, ${estimateBase64Bytes(b64)} bytes elided»`)
      continue
    }
    if (mime === "text/plain") {
      lines.push(cap(joinText(value), opts.maxOutputChars))
    }
    // Other MIMEs (text/html, application/json, …) are intentionally not
    // expanded here: text/plain is the model-facing repr nbformat always
    // co-emits, and html/json reprs duplicate it or carry markup noise.
  }
  return lines
}

/** Render a single output object by its `output_type`. Unknown types ⇒ no
 *  lines (fail-soft). */
const renderOutput = (output: unknown, opts: NotebookRenderOpts): string[] => {
  if (!isObject(output)) return []
  const kind = output["output_type"]
  if (kind === "stream") {
    return [cap(joinText(output["text"]), opts.maxOutputChars)]
  }
  if (kind === "execute_result" || kind === "display_data") {
    const data = output["data"]
    return isObject(data) ? renderDataOutput(data, opts) : []
  }
  if (kind === "error") {
    const ename = typeof output["ename"] === "string" ? output["ename"] : "Error"
    const evalue = typeof output["evalue"] === "string" ? output["evalue"] : ""
    const tb = Array.isArray(output["traceback"])
      ? output["traceback"].filter((l): l is string => typeof l === "string")
      : []
    const head = `${ename}: ${evalue}`.trimEnd()
    // Traceback lines carry ANSI color escapes from the kernel; keep them as-is
    // (they are short) but cap the joined block so a deep recursion trace can't
    // blow the budget.
    const body = tb.length > 0 ? `\n${cap(tb.join("\n"), opts.maxOutputChars)}` : ""
    return [head + body]
  }
  return []
}

/** Render one cell: a `[cell N · type]` header, the line-numbered source, and
 *  (when `includeOutputs`) its textual/base64-stripped outputs. */
const renderCell = (cell: unknown, index: number, opts: NotebookRenderOpts): string => {
  if (!isObject(cell)) return `[cell ${index} · unknown]`
  const type = typeof cell["cell_type"] === "string" ? cell["cell_type"] : "unknown"
  const header = `[cell ${index} · ${type}]`
  const body = numberLines(joinSource(cell["source"]))
  let block = body === "" ? header : `${header}\n${body}`

  if (opts.includeOutputs && Array.isArray(cell["outputs"]) && cell["outputs"].length > 0) {
    const allOutputs = cell["outputs"]
    const shownOutputs = Math.min(allOutputs.length, MAX_OUTPUTS_PER_CELL)
    const outLines: string[] = []
    for (let j = 0; j < shownOutputs; j++) outLines.push(...renderOutput(allOutputs[j], opts))
    const nonEmpty = outLines.filter((l) => l !== "")
    if (nonEmpty.length > 0) {
      block += `\n[output]\n${nonEmpty.join("\n")}`
    }
    if (allOutputs.length > shownOutputs) {
      block += `\n… (${allOutputs.length - shownOutputs} more output(s) elided: output cap ${MAX_OUTPUTS_PER_CELL})`
    }
  }
  return block
}

/** Render parsed notebook text into a cell-numbered, base64-stripped view.
 *  PURE. Returns `null` when the text is NOT parseable nbformat (no `cells`
 *  array) — the caller falls back to the raw render. NEVER throws. */
export const renderNotebook = (text: string, opts: NotebookRenderOpts): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null // not JSON ⇒ raw fallback
  }
  if (!isObject(parsed) || !Array.isArray(parsed["cells"])) return null
  const cells = parsed["cells"]
  if (cells.length === 0) return "(empty notebook: 0 cells)"
  const shown = Math.min(cells.length, MAX_NOTEBOOK_CELLS)
  const blocks: string[] = []
  for (let i = 0; i < shown; i++) blocks.push(renderCell(cells[i], i, opts))
  if (cells.length > shown) {
    blocks.push(`… (${cells.length - shown} more cell(s) elided: cell cap ${MAX_NOTEBOOK_CELLS})`)
  }
  return blocks.join("\n\n")
}
