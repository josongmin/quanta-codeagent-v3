/**
 * ADR-0422 — LSP-backed `SymbolLookupLspPort` adapter.
 *
 * Adapts the agent-slice `@/agent/lsp-bridge` nav provider (`lspNavProvider`,
 * which knows pyright / typescript-language-server) into the narrow
 * {@link SymbolLookupLspPort} the ADR-0418 `createSymbolResolver` consumes.
 *
 * Slice-fence: this module lives in the agent slice and imports the sibling
 * agent-slice `lsp-bridge` — the same direction `mcp-bridge.ts` /
 * `lsp-diagnostics-hook.ts` already take. The mention-resolver CORE stays
 * import-free against the LSP engine; only this wire-layer adapter crosses.
 *
 * Symbol lookup over LSP uses `workspaceSymbol(query)`. The nav provider
 * resolves a session by FILE (it picks the language server from the file's
 * extension), so the adapter opens a session against an ANCHOR FILE — a
 * representative file in the workspace whose extension selects the server.
 * The caller supplies it (e.g. the surface picks the most-edited / first
 * source file, or a fixed `tsconfig`-adjacent entry). When no anchor is
 * supplied / resolvable the adapter returns `null` (graceful — `@symbol`
 * falls through to the semantic strategy under `auto`).
 *
 * NO-THROW: every failure surface (no provider, `open` ⇒ null, a thrown
 * server, an empty / null payload) maps to `null`. The session is ALWAYS
 * stopped in a `finally` so a per-lookup server never leaks.
 *
 * `maxHits` caps the projected list so a pathological workspace-symbol
 * response cannot balloon the prompt; the resolver also caps at render time.
 */

import type { LspNavProvider, NavSymbolInfo } from "@/tool"
import type { SymbolHit, SymbolLookupLspPort } from "./symbol-resolver"

/** Options for {@link createLspSymbolLookup}. */
export interface LspSymbolLookupOptions {
  /** Nav provider (e.g. `lspNavProvider()` from `@/agent/lsp-bridge`). */
  readonly provider: LspNavProvider
  /** Workspace root passed to `provider.open(anchorFile, cwd)`. */
  readonly cwd: string
  /** Anchor file whose extension selects the language server. When omitted
   *  the adapter returns `null` for every lookup (no server to open). */
  readonly anchorFile?: string
  /** Cap on projected hits. Default 25. `<= 0` ⇒ default. */
  readonly maxHits?: number
}

const DEFAULT_MAX_HITS = 25

/** Project an LSP `NavSymbolInfo` into the mention `SymbolHit` envelope.
 *  `range.start.line` is 0-indexed in LSP ⇒ +1 for the 1-indexed `SymbolHit`.
 *  `containerName` (when present) becomes the snippet so the rendered body
 *  carries a little structural context. */
const toHit = (info: NavSymbolInfo): SymbolHit => {
  const line = info.range.start.line + 1
  const path = info.uri ?? ""
  const container =
    typeof info.containerName === "string" && info.containerName.length > 0
      ? `${info.containerName}.${info.name}`
      : info.name
  return { path, line, snippet: `${info.kind} ${container}` }
}

/** Open a session against the anchor, run the workspace-symbol query, project
 *  + cap, and ALWAYS stop the session. Extracted from the port closure so the
 *  closure body stays under the cognitive-complexity cap. NO-THROW. */
const lookupVia = async (
  opts: LspSymbolLookupOptions,
  anchor: string,
  name: string,
  cap: number,
): Promise<readonly SymbolHit[] | null> => {
  let session: Awaited<ReturnType<LspNavProvider["open"]>> = null
  try {
    session = await opts.provider.open(anchor, opts.cwd)
    if (session === null) return null
    const infos = await session.workspaceSymbol(name)
    if (infos === null || !Array.isArray(infos) || infos.length === 0) return null
    return infos.slice(0, cap).map(toHit)
  } catch {
    return null
  } finally {
    if (session !== null) await session.stop().catch(() => undefined)
  }
}

/**
 * Build a {@link SymbolLookupLspPort} over an {@link LspNavProvider}.
 *
 * @param opts — provider + workspace root (+ optional anchor file / cap).
 */
export const createLspSymbolLookup = (opts: LspSymbolLookupOptions): SymbolLookupLspPort => {
  const cap =
    typeof opts.maxHits === "number" && Number.isFinite(opts.maxHits) && opts.maxHits > 0
      ? Math.floor(opts.maxHits)
      : DEFAULT_MAX_HITS
  return {
    findSymbol: async (name: string): Promise<readonly SymbolHit[] | null> => {
      if (typeof name !== "string" || name.length === 0) return null
      const anchor = opts.anchorFile
      if (typeof anchor !== "string" || anchor.length === 0) return null
      return lookupVia(opts, anchor, name, cap)
    },
  }
}
