/**
 * B4 (jul-03) — `/mcp-resources` surface.
 *
 * The `mcp_read_resource_dir` model tool enumerates the DIRECT children of a
 * directory-shaped MCP resource uri, and its sibling `mcp_read_resource` writes
 * large blobs to disk (blob-to-disk). Both are model-invoke-only — there was no
 * user-facing way to SEE which resource dirs were fetched or where the blobs
 * landed on disk.
 *
 * `/mcp-resources` renders a bounded capture of those fetches: each record is a
 * resource-dir uri, the child entries it returned, and any blob-to-disk paths.
 * The surface builds a {@link McpResourceCapture} holder and threads its snapshot
 * onto `ctx.mcpResources`; the record producer is the tool-dispatch seam (a
 * follow-up tool-layer wire — see the module note in the surface report), so the
 * command is REACHABLE today and shows "empty" until a fetch is captured.
 *
 * Slice-clean: imports NO `@/tool` / `@/mcp` VALUE — a duck-typed record shape
 * mirrors the child-entry fields the tool returns.
 */

import type { SlashCommand, SlashContext } from "../slash-contract"

/** One child entry of a fetched resource dir — structural mirror of the tool's
 *  `ResourceEntry` (no `@/tool` value import). */
export interface McpResourceChild {
  readonly uri: string
  readonly name?: string
  readonly mimeType?: string
}

/** One captured `mcp_read_resource_dir` fetch (+ any blob-to-disk paths written
 *  by an associated `mcp_read_resource`). */
export interface McpResourceDirRecord {
  /** The directory-shaped resource uri that was read. */
  readonly uri: string
  /** The DIRECT children the read returned. */
  readonly children: readonly McpResourceChild[]
  /** Local disk paths any blob children were written to (blob-to-disk). Absent
   *  ⇒ no blobs materialized for this fetch. */
  readonly blobPaths?: readonly string[]
  /** Epoch-ms the fetch was captured (for stable newest-first ordering). */
  readonly at: number
}

/** Default retention cap for the capture ring (oldest-evicted). */
export const DEFAULT_MCP_RESOURCE_CAPTURE_CAP = 50

/** Bounded, surface-owned capture of resource-dir fetches. Producer side is the
 *  tool-dispatch seam; consumer side is `/mcp-resources`. Pure in-memory ring. */
export interface McpResourceCapture {
  /** Record a fetched resource dir (+ optional blob-to-disk paths). */
  record(rec: McpResourceDirRecord): void
  /** Newest-first snapshot of the retained records. */
  snapshot(): readonly McpResourceDirRecord[]
  size(): number
}

/** Build a fresh bounded {@link McpResourceCapture}. */
export const createMcpResourceCapture = (
  cap: number = DEFAULT_MCP_RESOURCE_CAPTURE_CAP,
): McpResourceCapture => {
  const records: McpResourceDirRecord[] = []
  return {
    record: (rec) => {
      records.push(rec)
      while (records.length > cap) records.shift()
    },
    snapshot: () => [...records].sort((a, b) => b.at - a.at),
    size: () => records.length,
  }
}

/** Render one fetched-dir record: a header + indented children + blob paths.
 *  Pure — returns the block's lines. */
const renderResourceRecord = (rec: McpResourceDirRecord): string[] => {
  const lines: string[] = [
    `  ${rec.uri} (${rec.children.length} child${rec.children.length === 1 ? "" : "ren"})`,
  ]
  for (const c of rec.children) {
    const kind = c.mimeType === "inode/directory" ? "dir " : "file"
    lines.push(`    [${kind}] ${c.name ?? c.uri}`)
  }
  if (rec.blobPaths !== undefined) {
    for (const p of rec.blobPaths) lines.push(`    ↳ blob → ${p}`)
  }
  return lines
}

/** Render the capture as scannable rows: one header per dir + indented children
 *  and blob paths. Pure — the caller supplies the live snapshot. */
export const renderMcpResources = (records: readonly McpResourceDirRecord[]): string => {
  const header = `MCP resources — ${records.length} fetched dir${records.length === 1 ? "" : "s"}:`
  return [header, ...records.flatMap(renderResourceRecord)].join("\n")
}

/** `/mcp-resources` — list fetched resource dirs + blob-to-disk paths. Absent
 *  slot ⇒ "not wired" + exit 0 (default-OFF byte-identical). */
export const mcpResourcesCmd: SlashCommand = {
  name: "/mcp-resources",
  describe: "List fetched MCP resource dirs + blob-to-disk paths (mcp_read_resource_dir)",
  category: "other",
  async run(args: readonly string[], ctx: SlashContext): Promise<number> {
    if (ctx.mcpResources === undefined) {
      ctx.out("/mcp-resources: not wired in this surface\n")
      return 0
    }
    if (args.length > 0) {
      ctx.err("/mcp-resources: takes no arguments\n")
      return 1
    }
    const records = ctx.mcpResources()
    if (records.length === 0) {
      ctx.out("/mcp-resources: no resource dirs fetched yet\n")
      return 0
    }
    ctx.out(`${renderMcpResources(records)}\n`)
    return 0
  },
}
