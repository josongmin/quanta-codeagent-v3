import { fileURLToPath } from "node:url"
import type {
  NavCallHierarchyEntry,
  NavHover,
  NavLocation,
  NavRenamePreview,
  NavSymbolInfo,
} from "./types"

/** Convert a `file://` URI to its OS path; non-`file:` URIs pass through. */
const uriToPath = (uri: string): string => {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri)
    } catch {
      return uri
    }
  }
  return uri
}

/** 1-based display coords (LSP internal coords are zero-based). */
const oneBased = (line: number, character: number): { line: number; col: number } => ({
  line: line + 1,
  col: character + 1,
})

/**
 * Format a list of locations under a labeled header. Conventions:
 *  - `null`  ⇒ underlying server did not implement / answer ⇒ "not supported here"
 *  - `[]`    ⇒ ran cleanly, zero hits ⇒ "no results"
 *  - non-empty ⇒ header `LABEL: N result(s)` + one `path:line:col` per location.
 */
export const formatLocations = (label: string, locs: NavLocation[] | null): string => {
  if (locs === null) return `${label}: not supported here`
  if (locs.length === 0) return `${label}: no results`
  const header = `${label}: ${locs.length} result(s)`
  const rows = locs.map((l) => {
    const { line, col } = oneBased(l.range.start.line, l.range.start.character)
    return `${uriToPath(l.uri)}:${line}:${col}`
  })
  return [header, ...rows].join("\n")
}

/**
 * Hover rendering. The position coords are the CALLER's 1-based display coords
 * (matches the input the tool received), so users can correlate the answer
 * with the request without an off-by-one.
 */
export const formatHover = (
  path: string,
  line: number,
  col: number,
  hover: NavHover | null,
): string => {
  if (hover === null) return `${path}:${line}:${col}: no hover`
  return `${path}:${line}:${col}: hover\n${hover.contents}`
}

/**
 * Symbol list (document or workspace). `scope` is the human-readable header
 * prefix (e.g. `document src/a.ts` or `workspace 'Foo'`). Each row is
 * `kind name[container.name] path:line:col`; when the symbol has no `uri`
 * (document-symbol responses are anchored to the open file), the path is
 * elided — only `:line:col` shows.
 */
export const formatSymbols = (scope: string, syms: NavSymbolInfo[] | null): string => {
  if (syms === null) return `${scope}: not supported here`
  if (syms.length === 0) return `${scope}: no results`
  const header = `${scope}: ${syms.length} result(s)`
  const rows = syms.map((s) => {
    const { line, col } = oneBased(s.selectionRange.start.line, s.selectionRange.start.character)
    const path = s.uri ? uriToPath(s.uri) : ""
    const named = s.containerName ? `${s.containerName}.${s.name}` : s.name
    return `${s.kind} ${named} ${path}:${line}:${col}`
  })
  return [header, ...rows].join("\n")
}

/**
 * Rename preview. Surfaces the placeholder (typically the current identifier
 * text the server intends to rename) and the exact 1-based range. `null` ⇒
 * the cursor is not on a renameable identifier.
 */
export const formatRenamePreview = (
  path: string,
  line: number,
  col: number,
  preview: NavRenamePreview | null,
): string => {
  if (preview === null) return `${path}:${line}:${col}: rename not available`
  const start = oneBased(preview.range.start.line, preview.range.start.character)
  const end = oneBased(preview.range.end.line, preview.range.end.character)
  return `Renameable identifier '${preview.placeholder}' at ${path}:${line}:${col} (range ${start.line}:${start.col}..${end.line}:${end.col})`
}

/**
 * Call hierarchy rendering (RFC jun-6). `direction` is `"incoming"` (callers)
 * or `"outgoing"` (callees). Conventions match {@link formatLocations}:
 *  - `null`  ⇒ server has no `callHierarchyProvider` ⇒ "not supported here".
 *  - `[]`    ⇒ resolved cleanly, zero edges ⇒ "no callers"/"no callees".
 *  - non-empty ⇒ header + one line per edge:
 *      `<kind> <name> <path>:<line>:<col> · N call site(s) [l:c, …]`
 *    where the call sites are the entry's `fromRanges` (the exact spots that
 *    call — the "what breaks where" payload), rendered 1-based in order.
 */
export const formatCallHierarchy = (
  direction: "incoming" | "outgoing",
  entries: NavCallHierarchyEntry[] | null,
): string => {
  const label = direction === "incoming" ? "incoming calls" : "outgoing calls"
  if (entries === null) return `${label}: not supported here`
  const empty = direction === "incoming" ? "no callers" : "no callees"
  if (entries.length === 0) return `${label}: ${empty}`
  const header = `${label}: ${entries.length} result(s)`
  const rows = entries.map((e) => {
    const { line, col } = oneBased(e.selectionRange.start.line, e.selectionRange.start.character)
    const sites = e.fromRanges.map((r) => {
      const p = oneBased(r.start.line, r.start.character)
      return `${p.line}:${p.col}`
    })
    const siteText = `${sites.length} call site(s)${sites.length > 0 ? ` [${sites.join(", ")}]` : ""}`
    return `${e.kind} ${e.name} ${uriToPath(e.uri)}:${line}:${col} · ${siteText}`
  })
  return [header, ...rows].join("\n")
}
