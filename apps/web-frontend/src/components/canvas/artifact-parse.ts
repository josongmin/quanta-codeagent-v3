/**
 * A2 (rich inline) — pure parsers for the artifact bytes the rich inline
 * renderers display.
 *
 * These are the DECISION-free, network-free, DOM-free core:
 *
 *   - `parseCsv`      — a small RFC-4180-ish CSV/TSV reader (quotes, embedded
 *                       delimiters, embedded newlines, doubled-quote escapes,
 *                       CRLF). Returns `{ header, rows }` or `null` when there is
 *                       nothing to grid — the caller then degrades to a download
 *                       card. NEVER throws, NEVER loops on unterminated quotes.
 *   - `boundCsvRows`  — cap the DOM row count (huge sheets stay bounded) and
 *                       report the hidden overflow for a "+N more" affordance.
 *   - `parseNotebook` — normalize a Jupyter `.ipynb` (nbformat) JSON into a flat
 *                       `NotebookCell[]` (markdown / code + text/image outputs).
 *                       Returns `null` for non-JSON or a doc with no `cells`
 *                       array. Malformed individual cells are skipped, not fatal.
 *
 * XSS posture: the parsers store cell / output text VERBATIM. They are a data
 * model, not a renderer — escaping is the React render layer's job (text nodes
 * are escaped by default; no `dangerouslySetInnerHTML` anywhere downstream).
 */

/* ------------------------------ CSV ------------------------------ */

import type { ChartTone } from "./ChartPrimitives"

export interface CsvTable {
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/**
 * Parse CSV/TSV text into a header + rows. `delimiter` defaults to `,`.
 *
 * State machine (single pass, bounded by input length): walks the string char
 * by char, tracking whether we are inside a quoted field. A doubled quote
 * (`""`) inside a quoted field is a literal quote. A quote that never closes
 * simply absorbs the remainder to EOF (degrade-safe — no infinite loop).
 *
 * Returns `null` when the input has no non-empty row (nothing to render).
 */
export const parseCsv = (text: string, delimiter = ","): CsvTable | null => {
  if (text.trim().length === 0) return null

  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  const n = text.length

  const endField = (): void => {
    row.push(field)
    field = ""
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < n; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++ // consume the escaped quote
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      endField()
    } else if (ch === "\n") {
      endRow()
    } else if (ch === "\r") {
      // CRLF: swallow the \r; the following \n ends the row. A lone \r also ends.
      if (text[i + 1] === "\n") {
        // let the \n handle the row break on the next iteration
      } else {
        endRow()
      }
    } else {
      field += ch
    }
  }
  // flush the trailing field/row (unless the string ended exactly on a newline,
  // in which case `field` is "" and `row` is empty).
  if (field.length > 0 || row.length > 0) endRow()

  // drop a single trailing fully-empty row (a file ending in "\n" yields one).
  const cleaned = rows.filter((r) => !(r.length === 1 && r[0] === ""))
  if (cleaned.length === 0) return null

  const [header, ...body] = cleaned
  return { header: header ?? [], rows: body }
}

export interface BoundedRows {
  readonly shown: readonly (readonly string[])[]
  readonly hidden: number
}

/** Cap `rows` at `limit` for the DOM; report how many were hidden. */
export const boundCsvRows = (rows: readonly (readonly string[])[], limit: number): BoundedRows => {
  if (rows.length <= limit) return { shown: rows, hidden: 0 }
  return { shown: rows.slice(0, limit), hidden: rows.length - limit }
}

/* ---------------------------- Notebook ---------------------------- */

export interface NotebookOutput {
  /** Flattened, human-readable text for stream / result / error outputs. */
  readonly text: string
  /** A `data:` URI for an image output (`image/png` | `image/jpeg`), if any. */
  readonly image?: string
  /** True for an error output (renderer can tint it). */
  readonly isError?: boolean
}

export interface NotebookCell {
  readonly type: "markdown" | "code" | "raw"
  readonly source: string
  readonly executionCount?: number
  readonly outputs?: readonly NotebookOutput[]
}

/** nbformat `source` is either a string or an array of line strings. */
const joinSource = (src: unknown): string => {
  if (typeof src === "string") return src
  if (Array.isArray(src)) return src.filter((s) => typeof s === "string").join("")
  return ""
}

/** nbformat text fields (`text`, `traceback`) are string | string[]. */
const joinText = (t: unknown): string => {
  if (typeof t === "string") return t
  if (Array.isArray(t)) return t.filter((s) => typeof s === "string").join("")
  return ""
}

const IMAGE_MIME = ["image/png", "image/jpeg"] as const

const normalizeOutput = (out: unknown): NotebookOutput | null => {
  if (out === null || typeof out !== "object") return null
  const o = out as Record<string, unknown>
  const kind = o.output_type

  if (kind === "stream") {
    return { text: joinText(o.text) }
  }
  if (kind === "error") {
    const tb = joinText(o.traceback)
    const head = [o.ename, o.evalue].filter((s) => typeof s === "string").join(": ")
    return { text: tb.length > 0 ? tb : head, isError: true }
  }
  if (kind === "execute_result" || kind === "display_data") {
    const data = (o.data ?? {}) as Record<string, unknown>
    // prefer an inline image; else fall back to text/plain.
    for (const mime of IMAGE_MIME) {
      const b64 = data[mime]
      if (typeof b64 === "string" && b64.length > 0) {
        return { text: "", image: `data:${mime};base64,${b64.replace(/\s+/g, "")}` }
      }
    }
    return { text: joinText(data["text/plain"]) }
  }
  return null
}

const normalizeCell = (cell: unknown): NotebookCell | null => {
  if (cell === null || typeof cell !== "object") return null
  const c = cell as Record<string, unknown>
  const type = c.cell_type
  if (type !== "markdown" && type !== "code" && type !== "raw") return null

  const base = { type, source: joinSource(c.source) } as const
  if (type !== "code") return base

  const outputs = Array.isArray(c.outputs)
    ? c.outputs.map(normalizeOutput).filter((o): o is NotebookOutput => o !== null)
    : []
  const execCount = typeof c.execution_count === "number" ? c.execution_count : undefined
  return {
    ...base,
    outputs,
    ...(execCount !== undefined ? { executionCount: execCount } : {}),
  }
}

/**
 * Parse `.ipynb` JSON into a flat cell list. Returns `null` for non-JSON or a
 * document with no `cells` array (⇒ caller degrades to a download card).
 * Individual malformed cells are dropped, not fatal.
 */
export const parseNotebook = (text: string): readonly NotebookCell[] | null => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== "object") return null
  const cells = (doc as Record<string, unknown>).cells
  if (!Array.isArray(cells)) return null
  return cells.map(normalizeCell).filter((c): c is NotebookCell => c !== null)
}

/* ------------------------------ Chart ------------------------------ */

/**
 * RFC-12 (deferred) SURFACE C — a parsed chart spec (bar / line / pie),
 * discriminated by `type`. The agent emits a `chart` artifact whose bytes are
 * JSON of this shape; `parseChart` normalizes it into props for
 * `ChartPrimitives`. Returns `null` for non-JSON / an unknown `type` / a spec
 * missing its required arrays (⇒ the caller degrades to the base download
 * card). Never throws.
 */
export type ChartSpec =
  | {
      readonly type: "bar"
      readonly categories: readonly string[]
      readonly series: readonly {
        readonly name: string
        readonly data: readonly number[]
        readonly tone?: ChartTone
      }[]
      readonly stacked?: boolean
      readonly valueSuffix?: string
    }
  | {
      readonly type: "line"
      readonly categories: readonly string[]
      readonly series: readonly {
        readonly name: string
        readonly data: readonly number[]
        readonly tone?: ChartTone
      }[]
      readonly fill?: boolean
      readonly valueSuffix?: string
    }
  | {
      readonly type: "pie"
      readonly data: readonly {
        readonly label: string
        readonly value: number
        readonly tone?: ChartTone
      }[]
      readonly donut?: boolean
    }

const TONES = new Set(["success", "danger", "warning", "info", "neutral"])
const asTone = (v: unknown): ChartTone | undefined =>
  typeof v === "string" && TONES.has(v) ? (v as ChartTone) : undefined

const asSeries = (raw: unknown): { name: string; data: number[]; tone?: ChartTone }[] | null => {
  if (!Array.isArray(raw)) return null
  const out: { name: string; data: number[]; tone?: ChartTone }[] = []
  for (const s of raw) {
    if (s === null || typeof s !== "object") continue
    const o = s as Record<string, unknown>
    if (!Array.isArray(o.data)) continue
    const data = o.data.map((v) => (typeof v === "number" ? v : Number.NaN))
    const tone = asTone(o.tone)
    out.push({
      name: typeof o.name === "string" ? o.name : "",
      data,
      ...(tone !== undefined ? { tone } : {}),
    })
  }
  return out
}

/** Parse a bar|line spec (they share `categories`+`series`). Returns null when
 *  the required arrays are missing / empty. */
const parseAxisChart = (o: Record<string, unknown>, type: "bar" | "line"): ChartSpec | null => {
  if (!Array.isArray(o.categories)) return null
  const series = asSeries(o.series)
  if (series === null || series.length === 0) return null
  const categories = o.categories.map((c) => (typeof c === "string" ? c : String(c)))
  if (type === "bar") {
    return {
      type: "bar",
      categories,
      series,
      ...(typeof o.stacked === "boolean" ? { stacked: o.stacked } : {}),
      ...(typeof o.valueSuffix === "string" ? { valueSuffix: o.valueSuffix } : {}),
    }
  }
  return {
    type: "line",
    categories,
    series,
    ...(typeof o.fill === "boolean" ? { fill: o.fill } : {}),
    ...(typeof o.valueSuffix === "string" ? { valueSuffix: o.valueSuffix } : {}),
  }
}

/** Parse a pie spec. Returns null when `data` is missing / has no valued point. */
const parsePieChart = (o: Record<string, unknown>): ChartSpec | null => {
  if (!Array.isArray(o.data)) return null
  const data: { label: string; value: number; tone?: ChartTone }[] = []
  for (const p of o.data) {
    if (p === null || typeof p !== "object") continue
    const po = p as Record<string, unknown>
    if (typeof po.value !== "number") continue
    const tone = asTone(po.tone)
    data.push({
      label: typeof po.label === "string" ? po.label : "",
      value: po.value,
      ...(tone !== undefined ? { tone } : {}),
    })
  }
  if (data.length === 0) return null
  return { type: "pie", data, ...(typeof o.donut === "boolean" ? { donut: o.donut } : {}) }
}

export const parseChart = (text: string): ChartSpec | null => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== "object") return null
  const o = doc as Record<string, unknown>
  const type = o.type
  if (type === "bar" || type === "line") return parseAxisChart(o, type)
  if (type === "pie") return parsePieChart(o)
  return null
}
