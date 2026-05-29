/** ADR-0141 — `lsp_signature_help` tool.
 *
 *  Issues `textDocument/signatureHelp` and surfaces the active overload +
 *  parameter for a cursor inside a function-call expression. Read-only,
 *  concurrency-safe. No HITL needed.
 *
 *  Slice isolation: `@/tool` MUST NOT import `@/lsp`. Canonical port at
 *  `@/lsp/ports/signature-help-port.ts`; duck-typed mirror declared HERE. */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"

// ── Duck-typed mirror of `SignatureHelpPort` ───────────────────────────────

export interface SignatureHelpPortParameter {
  label: string
  documentation?: string
}

export interface SignatureHelpPortInfo {
  label: string
  documentation?: string
  parameters: readonly SignatureHelpPortParameter[]
  activeParameter?: number | null
}

export interface SignatureHelpPort {
  signatureHelp(
    file: string,
    line: number,
    col: number,
    signal?: AbortSignal,
  ): Promise<readonly SignatureHelpPortInfo[] | null>
}

// ── Input schema ────────────────────────────────────────────────────────────

export const lspSignatureHelpInputSchema = z.object({
  path: z.string().min(1).describe("File whose language server should answer"),
  line: z.number().int().min(1).describe("1-based line number"),
  character: z.number().int().min(1).describe("1-based character offset"),
})
export type LspSignatureHelpInput = z.infer<typeof lspSignatureHelpInputSchema>

// ── Output formatting ───────────────────────────────────────────────────────

const renderSignatures = (
  path: string,
  line: number,
  character: number,
  sigs: readonly SignatureHelpPortInfo[] | null,
): string => {
  if (sigs === null) return `${path}:${line}:${character}: signature help not supported here`
  if (sigs.length === 0) return `${path}:${line}:${character}: no signature help (not in a call)`
  const header = `${path}:${line}:${character}: ${sigs.length} signature(s)`
  const rows = sigs.map((s, i) => {
    const ap = s.activeParameter
    const active =
      ap === null || ap === undefined || s.parameters.length === 0
        ? ""
        : ` ← active param: ${s.parameters[ap]?.label ?? `#${ap}`}`
    return `  ${i + 1}. ${s.label}${active}`
  })
  return [header, ...rows].join("\n")
}

// ── Factory ─────────────────────────────────────────────────────────────────

export const lspSignatureHelpTool = (port: SignatureHelpPort): Tool<LspSignatureHelpInput> => ({
  name: "lsp_signature_help",
  description:
    "Show parameter/overload help for the function call enclosing PATH:LINE:CHARACTER " +
    "(1-based). Returns the available signatures and indicates the active parameter when the " +
    "server reports one. Returns a clean message when no language server is available — never " +
    "fails the turn.",
  inputSchema: lspSignatureHelpInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = lspSignatureHelpInputSchema.safeParse(input)
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
    yield { type: "progress", message: `lsp_signature_help: querying ${parsed.data.path}` }
    let sigs: readonly SignatureHelpPortInfo[] | null
    try {
      sigs = await port.signatureHelp(
        parsed.data.path,
        parsed.data.line - 1,
        parsed.data.character - 1,
        ctx.signal,
      )
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `lsp_signature_help unavailable: ${errMessage(e)}`,
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderSignatures(parsed.data.path, parsed.data.line, parsed.data.character, sigs),
      },
    }
  },
})
