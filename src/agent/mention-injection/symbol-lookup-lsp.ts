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

import { errMessage, logger } from "@/shared"
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

/** Upstream projection cap — the LSP `workspaceSymbol` response is sliced to
 *  this many BEFORE the outer `symbol-resolver` applies its own (smaller)
 *  `DEFAULT_MAX_HITS=5` for the rendered prompt body. 25 absorbs noisy
 *  match-anywhere queries (e.g. `@foo` against a large codebase) without
 *  unbounded memory; the resolver tightens for display. Two distinct caps by
 *  design, NOT the audit-flagged "5 vs 25 inconsistency". */
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
  } catch (e) {
    logger.warn(`mention.symbol-lookup-lsp: ${errMessage(e)}`)
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

/** Options for {@link createUnionLspSymbolLookup}. */
export interface UnionLspSymbolLookupOptions {
  /** Nav provider (e.g. `lspNavProvider()`). Shared by every anchor. */
  readonly provider: LspNavProvider
  /** Workspace root passed to `provider.open(anchorFile, cwd)`. */
  readonly cwd: string
  /** Anchor files — one per language present in the workspace (synthesized by
   *  the deterministic `synthesizeLspAnchors`). Empty ⇒ every lookup is `null`
   *  (LSP strategy disabled). */
  readonly anchorFiles: readonly string[]
  /** Cap on projected hits PER ANCHOR. Default 25. `<= 0` ⇒ default. */
  readonly maxHits?: number
}

/** Stable dedup key for a {@link SymbolHit} so the same workspace symbol
 *  returned by two anchors (rare, but possible if one source file matched two
 *  language servers) is not double-rendered. */
const hitKey = (h: SymbolHit): string => `${h.path}:${h.line}:${h.snippet ?? ""}`

/** Query every per-anchor port in order and merge their hits, deduped by first
 *  occurrence. Extracted so the union closure stays under the cognitive-
 *  complexity cap. NO-THROW (each port already guards). */
const mergeAnchorHits = async (
  ports: readonly SymbolLookupLspPort[],
  name: string,
): Promise<readonly SymbolHit[]> => {
  const merged: SymbolHit[] = []
  const seen = new Set<string>()
  for (const port of ports) {
    const hits = await port.findSymbol(name)
    if (hits === null) continue
    for (const h of hits) {
      const key = hitKey(h)
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(h)
      }
    }
  }
  return merged
}

/**
 * Build a {@link SymbolLookupLspPort} that fans a query across SEVERAL anchor
 * files — one per language present in the workspace — and MERGES the hits. A
 * multi-language repo (`.ts` + `.py`) thus probes BOTH language servers under a
 * single `@symbol` lookup. Each anchor is queried via {@link createLspSymbolLookup}
 * so the per-anchor NO-THROW / always-stop-session contract is preserved; a
 * thrown / null anchor simply contributes nothing.
 *
 * Order is DETERMINISTIC: hits are concatenated in `anchorFiles` order (which
 * the synthesizer produces deterministically), deduped by first occurrence.
 * Empty result across all anchors ⇒ `null` (so `auto` treats it as a miss).
 *
 * @param opts — provider + workspace root + the synthesized anchor file list.
 */
export const createUnionLspSymbolLookup = (
  opts: UnionLspSymbolLookupOptions,
): SymbolLookupLspPort => {
  const anchors = Array.isArray(opts.anchorFiles) ? opts.anchorFiles : []
  const ports = anchors
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .map((anchorFile) =>
      createLspSymbolLookup({
        provider: opts.provider,
        cwd: opts.cwd,
        anchorFile,
        ...(opts.maxHits !== undefined ? { maxHits: opts.maxHits } : {}),
      }),
    )
  return {
    findSymbol: async (name: string): Promise<readonly SymbolHit[] | null> => {
      if (typeof name !== "string" || name.length === 0) return null
      if (ports.length === 0) return null
      const merged = await mergeAnchorHits(ports, name)
      return merged.length > 0 ? merged : null
    },
  }
}
