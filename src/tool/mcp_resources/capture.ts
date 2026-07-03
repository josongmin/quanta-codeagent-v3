/** B4 (jul-04 CLI-surfacing) — bounded PRODUCER-side capture holder for the
 *  `mcp_read_resource_dir` (+ `mcp_read_resource` blob-to-disk) tools.
 *
 *  The tools are model-invoke-only; before this holder there was no user-facing
 *  way to SEE which resource dirs were fetched or where blobs landed on disk.
 *  The holder is MINTED surface-side (CLI `loadFeatures`), threaded INTO the
 *  tools (producer) AND up to the `/mcp-resources` slash (consumer) — the same
 *  ONE-instance surface-mints→down-thread contract A3 `/kb` uses.
 *
 *  Pure in-memory ring (oldest-evicted, newest-first snapshot). No disk, no env,
 *  no clock — the caller supplies `at`. Slice-clean: this lives in `@/tool` so
 *  the tools can write into it without importing `@/apps/cli` (fence-safe); the
 *  slash-command's `McpResourceDirRecord` is a structural mirror of {@link
 *  CapturedResourceDir}, so `snapshot()` is directly assignable at the surface. */

/** One child entry the read-dir tool returned (metadata only — mirrors the
 *  tool's `ResourceEntry`, no body). */
export interface CapturedResourceChild {
  readonly uri: string
  readonly name?: string
  readonly mimeType?: string
}

/** One captured `mcp_read_resource_dir` fetch (+ any blob-to-disk paths a
 *  sibling `mcp_read_resource` wrote). */
export interface CapturedResourceDir {
  readonly uri: string
  readonly children: readonly CapturedResourceChild[]
  /** Local jailed paths any blob children were written to. KEY OMITTED when no
   *  blobs materialized (never `field: undefined`). */
  readonly blobPaths?: readonly string[]
  /** Epoch-ms the fetch was captured (caller-supplied — deterministic under a
   *  test clock). */
  readonly at: number
}

/** Default retention cap for the ring (oldest-evicted). Mirrors the S2 ItemStore
 *  / `/mcp-resources` slash default. */
export const DEFAULT_MCP_RESOURCE_CAPTURE_CAP = 50

/** Bounded capture: producer `record`s, consumer `snapshot`s (newest-first). */
export interface McpResourceCaptureHolder {
  /** Record a fetched resource dir (+ optional blob-to-disk paths). No-throw. */
  record(rec: CapturedResourceDir): void
  /** Newest-first snapshot of the retained records (stable by `at DESC`). */
  snapshot(): readonly CapturedResourceDir[]
  size(): number
}

/** Build a fresh bounded {@link McpResourceCaptureHolder}. */
export const createMcpResourceCaptureHolder = (
  cap: number = DEFAULT_MCP_RESOURCE_CAPTURE_CAP,
): McpResourceCaptureHolder => {
  const records: CapturedResourceDir[] = []
  return {
    record: (rec) => {
      records.push(rec)
      while (records.length > cap) records.shift()
    },
    // Copy before sort so the internal ring order (insertion) is never mutated.
    snapshot: () => [...records].sort((a, b) => b.at - a.at),
    size: () => records.length,
  }
}
