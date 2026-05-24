/**
 * `xlsx_read` tool (ADR-0137, Part 3) — STUB. The deps decision (SheetJS
 * `xlsx` vs `exceljs` vs custom OOXML parser) is DEFERRED to ADR-0138; this
 * file ships the slice shape so when that ADR lands, the impl swap is
 * byte-identical and existing callers see a typed deferral message in the
 * meantime.
 *
 * Why a stub (not an unregistered file):
 *   - The TOOL SURFACE is what enables downstream consumers (mode-table,
 *     skill router, docs) to declare the capability without waiting for
 *     the deps decision. Same posture as the `ToolResult.deferred` field —
 *     the contract exists; the resolution is plumbed later.
 *   - Hellgate seals the "execute returns the typed deferral" invariant so
 *     a future caller can't silently drop the stub.
 *
 * Slice posture (mirrors `csv-read.ts` / `yaml-read.ts`):
 *   - Imports ONLY: `zod`, `../types`. No FS, no parser, no path lib —
 *     the stub never reaches the filesystem.
 *   - No-throw: input validation surfaces as `ok:false` BEFORE the deferral
 *     message; this preserves the schema-validation contract every sibling
 *     reader implements.
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

export const xlsxReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the XLSX file"),
  sheet: z
    .string()
    .optional()
    .describe("Sheet name to read (default: first sheet). Reserved for when impl lands."),
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max rows to render (default 100, reserved for when impl lands)."),
})
export type XlsxReadInput = z.infer<typeof xlsxReadInputSchema>

/** The deferral message. Hellgate pins on this string so any caller wiring
 *  the stub before ADR-0138 ships sees a stable, regex-free signal. */
export const XLSX_READ_DEFERRAL_MESSAGE =
  "xlsx_read not yet implemented — deps decision deferred to ADR-0138. " +
  "Hint: extract a CSV/TSV from the spreadsheet upstream and use csv_read for now."

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

export const xlsxReadTool: Tool<XlsxReadInput> = {
  name: "xlsx_read",
  description:
    "Read an XLSX spreadsheet file. STUB — deps decision (SheetJS vs exceljs) " +
    "deferred to ADR-0138; calls return a typed deferral message. Read-only.",
  inputSchema: xlsxReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  // biome-ignore lint/correctness/useYield: stub generator — single result yield
  async *execute(input: XlsxReadInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    // Preserve the schema-validation contract every sibling reader implements:
    // a malformed input is rejected BEFORE the deferral message so callers can
    // distinguish "your call was malformed" from "this tool is not yet wired".
    const parsed = xlsxReadInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: errResult(`invalid input: ${parsed.error.message}`),
      }
      return
    }
    yield {
      type: "result",
      result: errResult(XLSX_READ_DEFERRAL_MESSAGE, {
        mode: "error",
        modelVisibleError: "xlsx_read_not_implemented",
      }),
    }
  },
}
