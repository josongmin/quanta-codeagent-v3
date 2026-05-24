/**
 * `csv_read` tool (ADR-0133, Part 1) — read + parse a CSV/TSV file.
 *
 * Slice posture (RFC §3.1):
 *   - Imports ONLY: `zod`, `node:path`, `node:fs/promises`, `../types`,
 *     and the sibling pure parser. NO `@/agent`, `@/permission`, `@/storage`.
 *   - No-throw: every failure mode (schema, abort, path-escape, ENOENT,
 *     symlink leaf, read failure) yields a typed `ok:false` `ToolResult`.
 *   - exactOptionalPropertyTypes-clean: optional fields are spelled
 *     `| undefined` on the schema so `z.optional()` parse output is assignable.
 *
 * Security (mirrors `read_image` posture, ADR-0126):
 *   - Repo-relative paths resolved against `ctx.cwd`; `..` traversal rejected
 *     (`path.resolve` + startsWith check).
 *   - Absolute paths pass through (explicit user consent — same posture as
 *     `git_diff` repo-absolute paths).
 *   - Leaf-symlink reject via `lstat().isSymbolicLink()`.
 *   - Output capped at 50_000 chars; row count capped via `maxRows` (default
 *     100, ceiling 1000).
 */

import { lstat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { parseCsv } from "./csv-parse"

export const CSV_READ_DEFAULT_MAX_ROWS = 100
export const CSV_READ_MAX_ROWS_CEILING = 1000
export const CSV_READ_MAX_OUTPUT = 50_000

export const csvReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the CSV/TSV file"),
  delimiter: z.string().optional().describe('Field delimiter (default ","). Use "\\t" for TSV.'),
  noHeader: z
    .boolean()
    .optional()
    .describe("Treat first row as data (default false — first row is headers)."),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(CSV_READ_MAX_ROWS_CEILING)
    .optional()
    .describe(
      `Max rows to render (default ${CSV_READ_DEFAULT_MAX_ROWS}, ceiling ${CSV_READ_MAX_ROWS_CEILING})`,
    ),
})
export type CsvReadInput = z.infer<typeof csvReadInputSchema>

const truncate = (s: string): string => {
  if (s.length <= CSV_READ_MAX_OUTPUT) return s
  return `${s.slice(0, CSV_READ_MAX_OUTPUT)}\n… (truncated, ${s.length - CSV_READ_MAX_OUTPUT} more chars)`
}

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Resolve repo-relative paths against `cwd`; absolute paths pass through. */
const resolveCsvPath = (
  raw: string,
  cwd: string,
): { abs: string; explicitlyAbsolute: boolean; withinCwd: boolean } => {
  const explicitlyAbsolute = path.isAbsolute(raw)
  const abs = explicitlyAbsolute ? path.resolve(raw) : path.resolve(cwd, raw)
  const resolvedCwd = path.resolve(cwd)
  const withinCwd = abs === resolvedCwd || abs.startsWith(resolvedCwd + path.sep)
  return { abs, explicitlyAbsolute, withinCwd }
}

const preflight = (
  input: CsvReadInput,
  ctx: ToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; abs: string; visiblePath: string } => {
  const parsed = csvReadInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  const { abs, explicitlyAbsolute, withinCwd } = resolveCsvPath(parsed.data.path, ctx.cwd)
  if (!explicitlyAbsolute && !withinCwd) {
    return {
      kind: "fail",
      result: errResult(`path outside cwd: ${parsed.data.path}`, {
        mode: "permission_denied",
        path: parsed.data.path,
        isReadonly: false,
      }),
    }
  }
  return { kind: "ok", abs, visiblePath: parsed.data.path }
}

const statPhase = async (
  abs: string,
  visiblePath: string,
): Promise<{ kind: "fail"; result: ToolResult } | { kind: "ok" }> => {
  try {
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) {
      return {
        kind: "fail",
        result: errResult(`symlink not allowed: ${visiblePath}`, {
          mode: "permission_denied",
          path: visiblePath,
          isReadonly: false,
        }),
      }
    }
    if (!stat.isFile()) {
      return {
        kind: "fail",
        result: errResult(`not a regular file: ${visiblePath}`, {
          mode: "not_found",
          path: visiblePath,
        }),
      }
    }
    return { kind: "ok" }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isEnoent =
      typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT"
    return {
      kind: "fail",
      result: errResult(
        isEnoent ? `File not found: ${visiblePath}` : `lstat failed: ${msg}`,
        isEnoent
          ? { mode: "not_found", path: visiblePath }
          : { mode: "error", modelVisibleError: msg },
      ),
    }
  }
}

/** Build the human/model-facing rendering. Pure. */
const renderResult = (
  visiblePath: string,
  parsed: ReturnType<typeof parseCsv>,
  maxRows: number,
  showHeaders: boolean,
): string => {
  const totalRows = parsed.rows.length
  const diagCount = parsed.diagnostics.length
  const lines: string[] = []
  lines.push(`CSV: ${visiblePath} (${totalRows} rows total, ${diagCount} diagnostics)`)
  if (showHeaders && parsed.headers) {
    lines.push(`Headers (${parsed.headers.length}): ${parsed.headers.join(", ")}`)
  }
  const shown = Math.min(maxRows, totalRows)
  lines.push(`Rows (showing ${shown}):`)
  for (let i = 0; i < shown; i++) {
    const row = parsed.rows[i]
    if (!row) continue
    const cellsJson = JSON.stringify(row.cells.map((c) => c.raw))
    lines.push(`  ${i + 1}. ${cellsJson}`)
  }
  if (totalRows > shown) {
    lines.push(`  … (${totalRows - shown} more rows; raise maxRows to see them)`)
  }
  if (diagCount > 0) {
    lines.push("")
    lines.push("Diagnostics:")
    for (const d of parsed.diagnostics) {
      lines.push(`  line ${d.line}: ${d.kind} — ${d.message}`)
    }
  }
  return truncate(lines.join("\n"))
}

export const csvReadTool: Tool<CsvReadInput> = {
  name: "csv_read",
  description:
    "Read and parse a CSV / TSV file. Returns headers, first N rows, and any " +
    "diagnostics (unterminated quote, ragged row, empty input). Read-only.",
  inputSchema: csvReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: CsvReadInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const pre = preflight(input, ctx)
    if (pre.kind === "fail") {
      yield { type: "result", result: pre.result }
      return
    }
    const statOut = await statPhase(pre.abs, pre.visiblePath)
    if (statOut.kind === "fail") {
      yield { type: "result", result: statOut.result }
      return
    }
    let text: string
    try {
      text = await Bun.file(pre.abs).text()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      yield {
        type: "result",
        result: errResult(`read failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    const parsedInput = csvReadInputSchema.parse(input)
    const parseOpts: { delimiter?: string; noHeader?: boolean } = {}
    if (parsedInput.delimiter !== undefined) parseOpts.delimiter = parsedInput.delimiter
    if (parsedInput.noHeader !== undefined) parseOpts.noHeader = parsedInput.noHeader
    const parsed = parseCsv(text, parseOpts)
    const maxRows = parsedInput.maxRows ?? CSV_READ_DEFAULT_MAX_ROWS
    const showHeaders = parsedInput.noHeader !== true
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderResult(pre.visiblePath, parsed, maxRows, showHeaders),
      },
    }
  },
}
