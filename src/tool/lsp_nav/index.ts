import { z } from "zod"
import { FsJailError, type JailedPath, resolveJailed } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { formatHover, formatLocations, formatRenamePreview, formatSymbols } from "./formatters"
import type {
  LspNavProvider,
  LspNavSession,
  NavHover,
  NavLocation,
  NavPos,
  NavRenamePreview,
  NavSymbolInfo,
} from "./types"

/**
 * `lsp_nav` tool slice — 8 navigation tools (definition / references / hover /
 * type-definition / implementation / document-symbol / workspace-symbol /
 * rename-preview).
 *
 * Slice isolation (RFC §3.1, enforced by biome): `@/tool` MUST NOT import
 * `@/lsp`. So this file owns no LSP knowledge; it talks to an injected
 * {@link LspNavProvider}. The real provider that knows about pyright /
 * typescript-language-server is assembled in `src/agent/lsp-bridge.ts` (the
 * agent slice is the only assembler allowed to cross slices — exactly how the
 * diagnostics tool does it). This keeps the tools unit-testable with a fake
 * provider in the normal gate (no real server needed).
 */

export {
  formatHover,
  formatLocations,
  formatRenamePreview,
  formatSymbols,
} from "./formatters"
export type {
  LspNavProvider,
  LspNavSession,
  NavHover,
  NavLocation,
  NavPos,
  NavRange,
  NavRenamePreview,
  NavSymbolInfo,
  NavSymbolKind,
} from "./types"

/** Shared 1-based position input — converted to 0-based NavPos internally. */
const positionSchema = z.object({
  path: z.string().describe("File whose language server should handle the request"),
  line: z.number().int().min(1).describe("1-based line number"),
  character: z.number().int().min(1).describe("1-based character offset"),
})

const documentSchema = z.object({
  path: z.string().describe("File whose document-symbols to enumerate"),
})

const workspaceSchema = z.object({
  path: z
    .string()
    .describe("Any file in the workspace whose language server should handle the query"),
  query: z.string().describe("Symbol search query (substring / fuzzy, server-defined)"),
})

const referencesSchema = positionSchema.extend({
  includeDeclaration: z
    .boolean()
    .optional()
    .describe("Include the declaration site in results (default true)"),
})

type PositionInput = z.infer<typeof positionSchema>
type DocumentInput = z.infer<typeof documentSchema>
type WorkspaceInput = z.infer<typeof workspaceSchema>
type ReferencesInput = z.infer<typeof referencesSchema>

/** 1-based human coords → 0-based LSP NavPos. */
const toNavPos = (line: number, character: number): NavPos => ({
  line: line - 1,
  character: character - 1,
})

/** S14: tool-supplied path → branded {@link JailedPath}. Throws
 *  {@link FsJailError} on escape; every call site catches and emits the
 *  standard `ok:false` result so a model that points at `/etc/passwd` gets
 *  a clean "outside the jail" message instead of opening the file.
 *  Returns `null` after emitting the result so callers can short-circuit. */
async function* absOrEmitJail(
  input: { path: string },
  ctx: ToolContext,
): AsyncGenerator<ToolEvent, JailedPath | null, undefined> {
  try {
    return resolveJailed(input.path, ctx.cwd)
  } catch (e) {
    if (e instanceof FsJailError) {
      yield { type: "result", result: { ok: false, output: e.message } }
      return null
    }
    throw e
  }
}

/**
 * Open a session and yield exactly one terminal `result` event on
 * unavailable / spawn-error paths. Returns the session for the caller to
 * drive on the happy path, or `null` when a terminal result has already been
 * emitted by this helper.
 */
async function* openOrEmitUnavailable(
  toolName: string,
  provider: LspNavProvider,
  abs: string,
  cwd: string,
): AsyncGenerator<ToolEvent, LspNavSession | null, undefined> {
  let session: LspNavSession | null
  try {
    session = await provider.open(abs, cwd)
  } catch (e) {
    yield {
      type: "result",
      result: { ok: false, output: `${toolName} unavailable: ${(e as Error).message}` },
    }
    return null
  }
  if (!session) {
    yield {
      type: "result",
      result: {
        ok: false,
        output: `${toolName} unavailable: ${provider.unavailableReason(abs)}`,
      },
    }
    return null
  }
  return session
}

/**
 * Generic "call session method, format result, always stop()" runner used by
 * all 8 tools. Keeps each tool's `execute` body small + uniform.
 */
async function* runSession<R>(
  toolName: string,
  session: LspNavSession,
  progressPath: string,
  call: (s: LspNavSession) => Promise<R>,
  format: (r: R) => string,
  successOnNonEmpty?: (r: R) => boolean,
): AsyncGenerator<ToolEvent, void, undefined> {
  yield { type: "progress", message: `analyzing ${progressPath}` }
  try {
    const payload = await call(session)
    const ok = successOnNonEmpty ? successOnNonEmpty(payload) : true
    yield { type: "result", result: { ok, output: format(payload) } }
  } catch (e) {
    yield {
      type: "result",
      result: { ok: false, output: `${toolName} failed: ${(e as Error).message}` },
    }
  } finally {
    await session.stop().catch(() => undefined)
  }
}

/** Position-input tool factory — eliminates 5x copy/paste for the
 *  definition/references/hover/typeDefinition/implementation/rename
 *  families. `kind` parameterizes only the session call and formatter. */
const positionTool = <I extends PositionInput>(
  name: string,
  inputSchema: z.ZodType<I>,
  call: (s: LspNavSession, fp: string, pos: NavPos, input: I) => Promise<unknown>,
  format: (input: I, abs: string, result: never) => string,
  provider: LspNavProvider,
): Tool<I> => ({
  name,
  description: `LSP ${name.replace(/^lsp_/, "").replace(/_/g, " ")} for the symbol at PATH:LINE:CHARACTER (1-based). Returns a clean message when no language server is available — never fails the turn.`,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async *execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const abs = yield* absOrEmitJail(input, ctx)
    if (abs === null) return
    const session = yield* openOrEmitUnavailable(name, provider, abs, ctx.cwd)
    if (!session) return
    yield* runSession(
      name,
      session,
      input.path,
      (s) => call(s, abs, toNavPos(input.line, input.character), input),
      (r) => format(input, abs, r as never),
    )
  },
})

/** Default no-op provider — every call degrades to a clean `ok:false` result. */
export const nullLspNavProvider: LspNavProvider = {
  unavailableReason: () => "no language server configured",
  open: async () => null,
}

/**
 * Build the 8 LSP-nav tools around a single provider. Conservative flags
 * mirror diagnostics: read-only (we only open + query, never mutate) and NOT
 * concurrency-safe (each call drives a per-session language-server subprocess
 * that interleaves didOpen / request traffic).
 */
export const lspNavTools = (provider: LspNavProvider): Tool[] => {
  const definition = positionTool<PositionInput>(
    "lsp_definition",
    positionSchema,
    (s, fp, pos) => s.definition(fp, pos),
    (_input, _abs, locs: NavLocation[] | null) => formatLocations("definition", locs),
    provider,
  )

  const references: Tool<ReferencesInput> = {
    name: "lsp_references",
    description:
      "LSP references for the symbol at PATH:LINE:CHARACTER (1-based). " +
      "Includes the declaration site unless includeDeclaration:false. " +
      "Returns a clean message when no language server is available — never fails the turn.",
    inputSchema: referencesSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async *execute(input: ReferencesInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const abs = yield* absOrEmitJail(input, ctx)
      if (abs === null) return
      const session = yield* openOrEmitUnavailable("lsp_references", provider, abs, ctx.cwd)
      if (!session) return
      const inc = input.includeDeclaration ?? true
      yield* runSession(
        "lsp_references",
        session,
        input.path,
        (s) => s.references(abs, toNavPos(input.line, input.character), inc),
        (r: NavLocation[] | null) => formatLocations("references", r),
      )
    },
  }

  const hover = positionTool<PositionInput>(
    "lsp_hover",
    positionSchema,
    (s, fp, pos) => s.hover(fp, pos),
    (input, _abs, hov: NavHover | null) =>
      formatHover(input.path, input.line, input.character, hov),
    provider,
  )

  const typeDefinition = positionTool<PositionInput>(
    "lsp_type_definition",
    positionSchema,
    (s, fp, pos) => s.typeDefinition(fp, pos),
    (_input, _abs, locs: NavLocation[] | null) => formatLocations("typeDefinition", locs),
    provider,
  )

  const implementation = positionTool<PositionInput>(
    "lsp_implementation",
    positionSchema,
    (s, fp, pos) => s.implementation(fp, pos),
    (_input, _abs, locs: NavLocation[] | null) => formatLocations("implementation", locs),
    provider,
  )

  const documentSymbol: Tool<DocumentInput> = {
    name: "lsp_document_symbol",
    description:
      "Enumerate document symbols (functions / classes / variables) for PATH. " +
      "Returns a clean message when no language server is available — never fails the turn.",
    inputSchema: documentSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async *execute(input: DocumentInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const abs = yield* absOrEmitJail(input, ctx)
      if (abs === null) return
      const session = yield* openOrEmitUnavailable("lsp_document_symbol", provider, abs, ctx.cwd)
      if (!session) return
      yield* runSession(
        "lsp_document_symbol",
        session,
        input.path,
        (s) => s.documentSymbol(abs),
        (r: NavSymbolInfo[] | null) => formatSymbols(`document ${input.path}`, r),
      )
    },
  }

  const workspaceSymbol: Tool<WorkspaceInput> = {
    name: "lsp_workspace_symbol",
    description:
      "Search workspace symbols matching QUERY via the language server selected by PATH. " +
      "Returns a clean message when no language server is available — never fails the turn.",
    inputSchema: workspaceSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async *execute(input: WorkspaceInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const abs = yield* absOrEmitJail(input, ctx)
      if (abs === null) return
      const session = yield* openOrEmitUnavailable("lsp_workspace_symbol", provider, abs, ctx.cwd)
      if (!session) return
      yield* runSession(
        "lsp_workspace_symbol",
        session,
        input.path,
        (s) => s.workspaceSymbol(input.query),
        (r: NavSymbolInfo[] | null) => formatSymbols(`workspace '${input.query}'`, r),
      )
    },
  }

  const renamePreview = positionTool<PositionInput>(
    "lsp_rename_preview",
    positionSchema,
    (s, fp, pos) => s.prepareRename(fp, pos),
    (input, _abs, preview: NavRenamePreview | null) =>
      formatRenamePreview(input.path, input.line, input.character, preview),
    provider,
  )

  return [
    definition as Tool,
    references as Tool,
    hover as Tool,
    typeDefinition as Tool,
    implementation as Tool,
    documentSymbol as Tool,
    workspaceSymbol as Tool,
    renamePreview as Tool,
  ]
}
