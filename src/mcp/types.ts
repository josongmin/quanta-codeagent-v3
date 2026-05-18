/** Public contract for the MCP stdio client slice.
 *
 *  These are the only shapes a downstream agent codes against; keep them
 *  stable. Everything else in this slice is an implementation detail. */

/** How to launch and address a single MCP server process. */
export interface McpServerConfig {
  /** Logical name for diagnostics/log correlation. */
  name: string
  /** argv to spawn (e.g. `["bun", "server.ts"]`). */
  command: string[]
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string
  /** Extra env merged over a minimal base. The full parent process env is
   *  intentionally NOT inherited so host secrets never leak to the server. */
  env?: Record<string, string>
}

/** A tool advertised by the server's `tools/list`. */
export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Outcome of a `tools/call`. `content` is every text content block joined by
 *  newlines; `ok` is false when the server set `result.isError`. */
export interface McpCallResult {
  ok: boolean
  content: string
}
