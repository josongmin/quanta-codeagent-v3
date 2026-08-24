/**
 * `xlsx_write` tool (H14b) — GENERATE a real `.xlsx` workbook from sheet data.
 *
 * The mutating counterpart to the read-only `xlsx_read`: it serializes
 * caller-supplied sheets (rows of cells) into a valid OOXML SpreadsheetML
 * package ({@link buildXlsx}) and writes the bytes through the FS-jail
 * chokepoint to a jailed, versioned-sibling path (never a silent overwrite).
 *
 * Posture:
 *   - `isReadOnly() => false` (mutating — it writes a file).
 *   - NO-THROW: every failure mode (schema, abort, jail escape, write error)
 *     yields a typed `ok:false` `ToolResult`.
 *   - Default-OFF: registered only when `DefaultToolPorts.officeAuthoring` is
 *     true (the composition root passes it iff `QUANTA_OFFICE_AUTHORING` is on),
 *     so the default tool menu is byte-identical.
 *
 * Slice posture (RFC §3.1): imports ONLY `zod`, `@/shared`, `@/storage`, the
 * sibling pure serializer + jailed-write helper, and `../../types`. No
 * `@/agent`, no `@/permission`.
 */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { ArtifactRegistryPort } from "../../artifact"
import type { CoreToolContext, Tool, ToolEvent, ToolResult } from "../../types"
import { OOXML_MEDIA_TYPES, registerArtifactBestEffort } from "./artifact-register"
import { resolveVersionedJailedTarget, writeJailedBytes } from "./jailed-write"
import { buildXlsx, type XlsxCellValue, type XlsxSpec } from "./xlsx"

/** Cap the workbook size so a runaway spec can't exhaust memory. */
export const XLSX_WRITE_MAX_SHEETS = 64
export const XLSX_WRITE_MAX_ROWS_PER_SHEET = 100_000
export const XLSX_WRITE_MAX_COLS_PER_ROW = 1024

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const sheetSchema = z.object({
  name: z.string().min(1).describe("Sheet tab name (sanitized to Excel rules: ≤31 chars)."),
  rows: z
    .array(z.array(cellSchema).max(XLSX_WRITE_MAX_COLS_PER_ROW))
    .max(XLSX_WRITE_MAX_ROWS_PER_SHEET)
    .describe("Rows of cells. Numbers become numeric cells; everything else a string."),
})

export const xlsxWriteInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Repo-relative or jailed output path for the .xlsx (e.g. reports/tracker.xlsx)."),
  sheets: z
    .array(sheetSchema)
    .min(1)
    .max(XLSX_WRITE_MAX_SHEETS)
    .describe("One or more sheets to write into the workbook."),
})
export type XlsxWriteInput = z.infer<typeof xlsxWriteInputSchema>

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

const toSpec = (input: XlsxWriteInput): XlsxSpec => ({
  sheets: input.sheets.map((s) => ({
    name: s.name,
    rows: s.rows.map((r) => r.map((c) => c as XlsxCellValue)),
  })),
})

/** Options for {@link makeXlsxWriteTool}. */
export interface XlsxWriteToolOptions {
  /** C1 — when wired (default-OFF, gated on `QUANTA_ARTIFACT_STORE`), the tool
   *  best-effort registers each written workbook into the session artifact
   *  registry and appends its id to the output. Absent ⇒ byte-identical. */
  readonly artifactRegistry?: ArtifactRegistryPort
}

/** Build the `xlsx_write` tool. With no options this is byte-identical to the
 *  historical const export (no artifact register, no extra output). */
export const makeXlsxWriteTool = (options: XlsxWriteToolOptions = {}): Tool<XlsxWriteInput> => ({
  name: "xlsx_write",
  description:
    "Generate a real .xlsx (Excel) workbook from sheet data (rows of cells + sheet names) " +
    "and write it to a jailed path. Numbers become numeric cells; other values become strings. " +
    "Never overwrites: an existing target is written to a versioned -vN sibling. Mutating.",
  inputSchema: xlsxWriteInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  async *execute(input: XlsxWriteInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = xlsxWriteInputSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: errResult("aborted before start") }
      return
    }

    const target = await resolveVersionedJailedTarget(ctx.cwd, parsed.data.path)
    if (target.kind === "jail_error") {
      yield {
        type: "result",
        result: errResult(`path outside cwd: ${parsed.data.path} (${target.message})`, {
          mode: "permission_denied",
          path: parsed.data.path,
          isReadonly: false,
        }),
      }
      return
    }

    let bytes: Uint8Array
    try {
      bytes = buildXlsx(toSpec(parsed.data))
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`xlsx serialize failed: ${msg}`, {
          mode: "error",
          modelVisibleError: msg,
        }),
      }
      return
    }

    try {
      await writeJailedBytes(target.abs, bytes)
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: errResult(`write failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }

    const sheetCount = parsed.data.sheets.length
    const note = target.bumped
      ? ` (target existed — wrote versioned sibling "${target.finalRelative}")`
      : ""
    // C1 — best-effort artifact registration AFTER a successful write. A throwing
    // registry never breaks the write; absent registry ⇒ no extra output.
    const registered = registerArtifactBestEffort(options.artifactRegistry, {
      kind: "spreadsheet",
      path: target.abs,
      mediaType: OOXML_MEDIA_TYPES.xlsx,
    })
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          `Wrote .xlsx (${bytes.length} bytes, ${sheetCount} sheet${sheetCount === 1 ? "" : "s"}) ` +
          `to ${target.finalRelative}${note}${registered}`,
      },
    }
  },
})

/** Const export — byte-identical to the historical tool (no artifact registry). */
export const xlsxWriteTool: Tool<XlsxWriteInput> = makeXlsxWriteTool()
