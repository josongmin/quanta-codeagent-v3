/** ADR-0141 — `lsp_code_action` tool.
 *
 *  RESOLVES the LSP `textDocument/codeAction` list at `path:line:character`
 *  (1-based) and surfaces the available quick-fixes / refactors to the model.
 *  Read-only: this tool only ENUMERATES — it does not apply. Applying is a
 *  separate concern (the rename-apply / format / future apply-edit tools).
 *  Concurrency-safe: enumeration has no observable side effect.
 *
 *  Slice isolation (RFC §3.1, enforced by biome): `@/tool` MUST NOT import
 *  `@/lsp`. The canonical port lives in `@/lsp/ports/code-action-port.ts`; the
 *  tool consumes a duck-typed structural mirror declared HERE so the fence
 *  holds. Test fakes satisfy both structurally — they are byte-compatible.
 *
 *  Plane-clean: imports only `zod`, `../types` (`Tool`, `ToolContext`,
 *  `ToolEvent`), and the in-file mirror port. No `@/agent`, `@/permission`,
 *  `@/lsp`, `@/storage`. */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"

// ── Duck-typed mirror of `CodeActionPort` (`@/lsp/ports/code-action-port`) ──
// Adding a field to the canonical port must be mirrored here. The slice fence
// prevents a `satisfies` round-trip inside this file; consumer-side tests in
// `tests/unit/` (which CAN see both slices) catch drift.

export interface CodeActionPortPos {
  line: number
  character: number
}

export interface CodeActionPortRange {
  start: CodeActionPortPos
  end: CodeActionPortPos
}

export interface CodeActionPortTextEdit {
  range: CodeActionPortRange
  newText: string
}

export interface CodeActionPortDocumentEdit {
  uri: string
  edits: readonly CodeActionPortTextEdit[]
}

export interface CodeActionPortWorkspaceEdit {
  changes: readonly CodeActionPortDocumentEdit[]
}

export type CodeActionPortKind =
  | "quickfix"
  | "refactor"
  | "refactor.extract"
  | "refactor.inline"
  | "refactor.rewrite"
  | "source"
  | "source.organizeImports"
  | "source.fixAll"
  | "other"

export interface CodeActionPortAction {
  title: string
  kind: CodeActionPortKind
  edit?: CodeActionPortWorkspaceEdit
}

export interface CodeActionPort {
  resolveCodeActions(
    file: string,
    line: number,
    col: number,
    kind?: CodeActionPortKind,
  ): Promise<readonly CodeActionPortAction[] | null>
  applyEdit(edit: CodeActionPortWorkspaceEdit): Promise<void>
}

// ── Input schema ────────────────────────────────────────────────────────────

const codeActionKindSchema = z.enum([
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.fixAll",
  "other",
])

export const lspCodeActionInputSchema = z.object({
  path: z.string().min(1).describe("File whose language server should answer"),
  line: z.number().int().min(1).describe("1-based line number"),
  character: z.number().int().min(1).describe("1-based character offset"),
  kind: codeActionKindSchema.optional().describe("Filter to a single CodeActionKind (exact match)"),
})
export type LspCodeActionInput = z.infer<typeof lspCodeActionInputSchema>

// ── Output formatting ───────────────────────────────────────────────────────

const renderActions = (
  path: string,
  line: number,
  character: number,
  actions: readonly CodeActionPortAction[] | null,
): string => {
  if (actions === null) return `${path}:${line}:${character}: code actions not supported here`
  if (actions.length === 0) return `${path}:${line}:${character}: no code actions available`
  const header = `${path}:${line}:${character}: ${actions.length} code action(s)`
  const rows = actions.map((a, i) => {
    const editFiles = a.edit?.changes.length ?? 0
    const tail = editFiles > 0 ? ` (edits ${editFiles} file${editFiles === 1 ? "" : "s"})` : ""
    return `  ${i + 1}. [${a.kind}] ${a.title}${tail}`
  })
  return [header, ...rows].join("\n")
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Build the `lsp_code_action` tool around a {@link CodeActionPort}. */
export const lspCodeActionTool = (port: CodeActionPort): Tool<LspCodeActionInput> => ({
  name: "lsp_code_action",
  description:
    "Enumerate LSP code actions (quick-fixes / refactors) available at PATH:LINE:CHARACTER " +
    "(1-based). Returns the list of titles + kinds; does NOT apply any edit. Optional `kind` " +
    "filters to a specific CodeActionKind (e.g. 'quickfix', 'refactor.extract', " +
    "'source.organizeImports'). Returns a clean message when no language server is available — " +
    "never fails the turn.",
  inputSchema: lspCodeActionInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = lspCodeActionInputSchema.safeParse(input)
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
    yield { type: "progress", message: `lsp_code_action: querying ${parsed.data.path}` }
    let actions: readonly CodeActionPortAction[] | null
    try {
      actions = await port.resolveCodeActions(
        parsed.data.path,
        parsed.data.line - 1,
        parsed.data.character - 1,
        parsed.data.kind,
      )
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `lsp_code_action unavailable: ${(e as Error).message}`,
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderActions(parsed.data.path, parsed.data.line, parsed.data.character, actions),
      },
    }
  },
})
