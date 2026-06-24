/** ADR-0141 — `lsp_rename_apply` tool.
 *
 *  Issues `textDocument/rename` AND applies the resulting workspace edit. Two-
 *  step internally (compute → apply) so the tool can emit a deterministic
 *  preview on `progress` before the HITL gate clears for the mutation.
 *
 *  Mutating + destructive — `hitlTier: "always-confirm"`. The HITL gate
 *  ALWAYS asks the operator before any file is touched (cannot be skipped by
 *  acceptEdits / pre-approval). `isReadOnly: false`, `isConcurrencySafe:
 *  false` — concurrent renames against the same workspace would race.
 *
 *  Slice isolation: `@/tool` MUST NOT import `@/lsp`. The canonical port lives
 *  in `@/lsp/ports/rename-apply-port.ts`; the tool consumes a duck-typed
 *  structural mirror declared HERE so the fence holds. Test fakes satisfy
 *  both structurally. Plane-clean: only `zod` + `../types` + in-file mirror. */

import { z } from "zod"
import { errMessage } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

// ── Duck-typed mirror of `RenameApplyPort` ─────────────────────────────────

export interface RenameApplyPortPos {
  line: number
  character: number
}

export interface RenameApplyPortRange {
  start: RenameApplyPortPos
  end: RenameApplyPortPos
}

export interface RenameApplyPortTextEdit {
  range: RenameApplyPortRange
  newText: string
}

export interface RenameApplyPortDocumentEdit {
  uri: string
  edits: readonly RenameApplyPortTextEdit[]
}

export interface RenameApplyPortWorkspaceEdit {
  changes: readonly RenameApplyPortDocumentEdit[]
}

export interface RenameApplyPort {
  computeRename(
    file: string,
    line: number,
    col: number,
    newName: string,
    signal?: AbortSignal,
  ): Promise<RenameApplyPortWorkspaceEdit | null>
  applyEdit(edit: RenameApplyPortWorkspaceEdit, signal?: AbortSignal): Promise<void>
}

// ── Input schema ────────────────────────────────────────────────────────────

export const lspRenameApplyInputSchema = z.object({
  path: z.string().min(1).describe("File whose language server should answer"),
  line: z.number().int().min(1).describe("1-based line number of the identifier"),
  character: z.number().int().min(1).describe("1-based character offset"),
  newName: z.string().min(1).describe("New identifier name to rename to"),
})
export type LspRenameApplyInput = z.infer<typeof lspRenameApplyInputSchema>

// ── Output formatting ───────────────────────────────────────────────────────

const renderApplied = (
  path: string,
  line: number,
  character: number,
  newName: string,
  edit: RenameApplyPortWorkspaceEdit,
): string => {
  const fileCount = edit.changes.length
  const editCount = edit.changes.reduce((acc, c) => acc + c.edits.length, 0)
  return (
    `Renamed symbol at ${path}:${line}:${character} to '${newName}'. ` +
    `Applied ${editCount} edit${editCount === 1 ? "" : "s"} across ` +
    `${fileCount} file${fileCount === 1 ? "" : "s"}.`
  )
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const lspRenameApplyTool = (port: RenameApplyPort): Tool<LspRenameApplyInput> => ({
  name: "lsp_rename_apply",
  description:
    "Rename the identifier at PATH:LINE:CHARACTER (1-based) to NEWNAME via the language " +
    "server's `textDocument/rename`, then APPLY the resulting workspace edit. DESTRUCTIVE — " +
    "modifies every file that references the symbol. Requires HITL confirmation (cannot be " +
    "skipped by acceptEdits / pre-approval).",
  inputSchema: lspRenameApplyInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = lspRenameApplyInputSchema.safeParse(input)
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
    yield {
      type: "progress",
      message: `lsp_rename_apply: computing rename of ${parsed.data.path}:${parsed.data.line}:${parsed.data.character} → ${parsed.data.newName}`,
    }
    let edit: RenameApplyPortWorkspaceEdit | null
    try {
      edit = await port.computeRename(
        abs,
        parsed.data.line - 1,
        parsed.data.character - 1,
        parsed.data.newName,
        ctx.signal,
      )
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `lsp_rename_apply unavailable: ${errMessage(e)}`,
        },
      }
      return
    }
    if (edit === null) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `${parsed.data.path}:${parsed.data.line}:${parsed.data.character}: rename not available`,
        },
      }
      return
    }
    if (edit.changes.length === 0) {
      yield {
        type: "result",
        result: {
          ok: true,
          output: `${parsed.data.path}:${parsed.data.line}:${parsed.data.character}: rename produced no edits (symbol unused)`,
        },
      }
      return
    }
    yield { type: "progress", message: "lsp_rename_apply: applying workspace edit" }
    try {
      await port.applyEdit(edit, ctx.signal)
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `lsp_rename_apply applyEdit failed: ${errMessage(e)}`,
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderApplied(
          parsed.data.path,
          parsed.data.line,
          parsed.data.character,
          parsed.data.newName,
          edit,
        ),
      },
    }
  },
})
