/** ADR-0141 — `lsp_format` tool.
 *
 *  Issues `textDocument/formatting` (whole file) or `textDocument/rangeFormatting`
 *  (selection) via the language server and surfaces the edits. The tool itself
 *  does NOT apply edits to the filesystem in v1 — it returns the edit summary
 *  so the operator can decide. (A future companion tool wires apply through
 *  the same workspace-edit channel.)
 *
 *  `isReadOnly: false` (the SEMANTIC intent is to mutate; even though v1
 *  surfaces only the edit set, future iterations will apply) and
 *  `isConcurrencySafe: false`. HITL tier is `pre-approval-ok` — formatting is
 *  routine and idempotent; one upfront approval is the right ergonomics.
 *
 *  Slice isolation: `@/tool` MUST NOT import `@/lsp`. Canonical port at
 *  `@/lsp/ports/format-port.ts`; duck-typed mirror declared HERE. */

import { z } from "zod"
import { errMessage } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

// ── Duck-typed mirror of `FormatPort` ──────────────────────────────────────

export interface FormatPortPos {
  line: number
  character: number
}

export interface FormatPortRange {
  start: FormatPortPos
  end: FormatPortPos
}

export interface FormatPortTextEdit {
  range: FormatPortRange
  newText: string
}

export interface FormatPort {
  format(
    file: string,
    range?: FormatPortRange,
    signal?: AbortSignal,
  ): Promise<readonly FormatPortTextEdit[] | null>
}

// ── Input schema ────────────────────────────────────────────────────────────

const rangeInputSchema = z.object({
  startLine: z.number().int().min(1),
  startCharacter: z.number().int().min(1),
  endLine: z.number().int().min(1),
  endCharacter: z.number().int().min(1),
})

export const lspFormatInputSchema = z.object({
  path: z.string().min(1).describe("File to format"),
  range: rangeInputSchema
    .optional()
    .describe("Optional 1-based range. Absent ⇒ whole-file formatting."),
})
export type LspFormatInput = z.infer<typeof lspFormatInputSchema>

// ── Output formatting ───────────────────────────────────────────────────────

const renderEdits = (
  path: string,
  scope: string,
  edits: readonly FormatPortTextEdit[] | null,
): string => {
  if (edits === null) return `${path}: format not supported here`
  if (edits.length === 0) return `${path}: ${scope} already formatted (no edits)`
  return `${path}: ${scope} produced ${edits.length} edit${edits.length === 1 ? "" : "s"}`
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const lspFormatTool = (port: FormatPort): Tool<LspFormatInput> => ({
  name: "lsp_format",
  description:
    "Format PATH via the language server. Optional `range` (1-based startLine/startCharacter/" +
    "endLine/endCharacter) targets a selection; absent ⇒ whole-file formatting. Returns an " +
    "edit-count summary; does not write to disk in v1.",
  inputSchema: lspFormatInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = lspFormatInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    // S14 FS-jail (parity with the nav tools): refuse path escapes before any
    // language-server contact.
    let abs: string
    try {
      abs = resolveJailed(parsed.data.path, ctx.cwd)
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
    const scope = parsed.data.range ? "range format" : "format"
    yield { type: "progress", message: `lsp_format: ${scope} ${parsed.data.path}` }
    let edits: readonly FormatPortTextEdit[] | null
    try {
      const r = parsed.data.range
      // exactOptionalPropertyTypes — only pass `range` when present.
      // Pass the original (relative) path to the port — abs was used only for
      // the FS-jail check above (parity with signature-help / code-action).
      if (r === undefined) {
        edits = await port.format(parsed.data.path, undefined, ctx.signal)
      } else {
        edits = await port.format(
          parsed.data.path,
          {
            start: { line: r.startLine - 1, character: r.startCharacter - 1 },
            end: { line: r.endLine - 1, character: r.endCharacter - 1 },
          },
          ctx.signal,
        )
      }
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `lsp_format unavailable: ${errMessage(e)}`,
        },
      }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: renderEdits(parsed.data.path, scope, edits) },
    }
  },
})
