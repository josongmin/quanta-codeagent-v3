/**
 * `ndjson_read` tool (ADR-0133, Part 2) — read + parse a newline-delimited
 * JSON file. Per-line errors are surfaced inline; one bad line does not abort
 * the rest. Read-only.
 *
 * Slice posture mirrors `csv_read` (see ../document/csv-read.ts).
 */

import { lstat } from "node:fs/promises"
import { z } from "zod"
import { errMessage } from "@/shared"
import { FsJailError } from "@/storage"
import { resolveJailedDoc } from "../_shared/resolve-jailed-doc"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { parseNdjson } from "./ndjson-parse"
export const NDJSON_READ_DEFAULT_MAX_LINES = 100
export const NDJSON_READ_MAX_LINES_CEILING = 1000
export const NDJSON_READ_MAX_OUTPUT = 50_000

export const ndjsonReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the NDJSON file"),
  maxLines: z
    .number()
    .int()
    .positive()
    .max(NDJSON_READ_MAX_LINES_CEILING)
    .optional()
    .describe(
      `Max lines to render (default ${NDJSON_READ_DEFAULT_MAX_LINES}, ceiling ${NDJSON_READ_MAX_LINES_CEILING})`,
    ),
})
export type NdjsonReadInput = z.infer<typeof ndjsonReadInputSchema>

const truncate = (s: string): string => {
  if (s.length <= NDJSON_READ_MAX_OUTPUT) return s
  return `${s.slice(0, NDJSON_READ_MAX_OUTPUT)}\n… (truncated, ${s.length - NDJSON_READ_MAX_OUTPUT} more chars)`
}

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

/** Pre-flight (schema parse + abort + path resolve via unified FS jail).
 *  Path safety is delegated to {@link resolveJailedDoc} (Slice S7) — see
 *  `src/tool/_shared/resolve-jailed-doc.ts` for rationale. The catch-and-
 *  translate preserves the historical "path outside cwd: …" message + typed
 *  `permission_denied` failure so existing hellgate tests stay green. */
const preflight = (
  input: NdjsonReadInput,
  ctx: ToolContext,
): { kind: "fail"; result: ToolResult } | { kind: "ok"; abs: string; visiblePath: string } => {
  const parsed = ndjsonReadInputSchema.safeParse(input)
  if (!parsed.success) {
    return { kind: "fail", result: errResult(`invalid input: ${parsed.error.message}`) }
  }
  if (ctx.signal.aborted) {
    return { kind: "fail", result: errResult("aborted before start") }
  }
  let abs: string
  try {
    abs = resolveJailedDoc(ctx.cwd, parsed.data.path, "ndjson")
  } catch (e) {
    if (e instanceof FsJailError) {
      return {
        kind: "fail",
        result: errResult(`path outside cwd: ${parsed.data.path}`, {
          mode: "permission_denied",
          path: parsed.data.path,
          isReadonly: true,
        }),
      }
    }
    throw e
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
          isReadonly: true,
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
    const msg = errMessage(e)
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

const renderResult = (
  visiblePath: string,
  parsed: ReturnType<typeof parseNdjson>,
  maxLines: number,
): string => {
  const totalLines = parsed.lines.length
  const lines: string[] = []
  lines.push(`NDJSON: ${visiblePath} (${totalLines} lines, ${parsed.errorCount} parse errors)`)
  const shown = Math.min(maxLines, totalLines)
  lines.push(`Lines (showing ${shown}):`)
  for (let i = 0; i < shown; i++) {
    const entry = parsed.lines[i]
    if (!entry) continue
    if (entry.error !== undefined) {
      lines.push(`  L${entry.lineNumber}: <ERROR: ${entry.error}>`)
    } else {
      lines.push(`  L${entry.lineNumber}: ${JSON.stringify(entry.value)}`)
    }
  }
  if (totalLines > shown) {
    lines.push(`  … (${totalLines - shown} more lines; raise maxLines to see them)`)
  }
  return truncate(lines.join("\n"))
}

export const ndjsonReadTool: Tool<NdjsonReadInput> = {
  name: "ndjson_read",
  description:
    "Read and parse a newline-delimited JSON file. Returns parsed objects + " +
    "per-line errors (one bad line does not abort the rest). Read-only.",
  inputSchema: ndjsonReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: NdjsonReadInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
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
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`read failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    const parsed = parseNdjson(text)
    const parsedInput = ndjsonReadInputSchema.parse(input)
    const maxLines = parsedInput.maxLines ?? NDJSON_READ_DEFAULT_MAX_LINES
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderResult(pre.visiblePath, parsed, maxLines),
      },
    }
  },
}
