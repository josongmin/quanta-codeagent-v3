/**
 * RFC-12 / ADR-0439 §4.2 — Symbol candidate lister.
 *
 * Reuses the EXISTING `SymbolLookupLspPort` (`@/agent/mention-injection`,
 * built by `createLspSymbolLookup` over the LSP `workspaceSymbol` query) to
 * enumerate `@SymbolName` candidates. No new LSP machinery — this adapter
 * only projects the `SymbolHit[]` the port already returns into
 * {@link AtCandidate} rows.
 *
 * Graceful: an absent port, an unconfigured LSP (no anchor file), or a null
 * payload ⇒ `[]` — exactly the `symbol-lookup-lsp.ts` "no anchor ⇒ null"
 * behaviour. NO-THROW (the port guards internally; this adapter re-guards).
 */

import type { SymbolHit, SymbolLookupLspPort } from "@/agent/mention-injection"
import type { AtCandidate } from "./port"

/** Options for {@link createSymbolLister}. */
export interface SymbolListerOptions {
  /** LSP symbol lookup port (`createLspSymbolLookup(...)`). Absent ⇒ every
   *  call returns `[]`. */
  readonly symbolLookup?: SymbolLookupLspPort
  /** Max candidates returned. Default 8. */
  readonly maxResults?: number
}

const DEFAULT_MAX = 8

/** Project an LSP `SymbolHit` into an `@symbol` candidate. The `path:line`
 *  becomes the dim detail column (RFC §4.4 mockup). */
const toCandidate = (hit: SymbolHit): AtCandidate | null => {
  // The LSP `workspaceSymbol` snippet is `"<kind> <container>.<name>"`; the
  // bare symbol name lives at the snippet tail. We surface the snippet's
  // trailing identifier as the insert token so submit-time `parseMentions`
  // re-classifies it as a `symbol` mention (which requires an uppercase
  // leading identifier). If no uppercase identifier is recoverable the hit
  // is dropped (a lowercase-only match cannot round-trip as `@symbol`).
  const snippet = hit.snippet ?? ""
  const m = snippet.match(/([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*$/)
  if (m === null) return null
  const name = m[1] ?? ""
  if (name === "") return null
  const loc = hit.path !== "" ? `${hit.path}:${hit.line}` : `:${hit.line}`
  return { kind: "symbol", insertText: `@${name}`, label: name, detail: loc }
}

/**
 * Build a symbol lister over a {@link SymbolLookupLspPort}. Returns a
 * function `(query, signal) ⇒ candidates`. An empty query ⇒ `[]` (the LSP
 * `workspaceSymbol("")` is not a useful "list everything" probe).
 */
export const createSymbolLister = (
  opts: SymbolListerOptions,
): ((query: string, signal?: AbortSignal) => Promise<readonly AtCandidate[]>) => {
  const port = opts?.symbolLookup
  const max =
    typeof opts?.maxResults === "number" && Number.isFinite(opts.maxResults) && opts.maxResults > 0
      ? Math.trunc(opts.maxResults)
      : DEFAULT_MAX
  return async (query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]> => {
    if (port === undefined) return []
    if (typeof query !== "string" || query.length === 0) return []
    if (signal?.aborted) return []
    let hits: readonly SymbolHit[] | null
    try {
      hits = await port.findSymbol(query)
    } catch {
      return []
    }
    if (hits === null || signal?.aborted) return []
    return projectHits(hits, max)
  }
}

/** Project + cap a hit list into candidates. Extracted from the lister closure
 *  to keep its complexity under the cap. */
const projectHits = (hits: readonly SymbolHit[], max: number): readonly AtCandidate[] => {
  const out: AtCandidate[] = []
  for (const hit of hits) {
    if (out.length >= max) break
    const cand = toCandidate(hit)
    if (cand !== null) out.push(cand)
  }
  return out
}
