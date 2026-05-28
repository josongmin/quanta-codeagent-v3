/** Public contract for the MCP stdio client slice.
 *
 *  These are the only shapes a downstream agent codes against; keep them
 *  stable. Everything else in this slice is an implementation detail. */

/** How to launch and address a single MCP server.
 *
 *  Default carrier is stdio (a spawned `command`). Setting `url` opts into the
 *  Streamable-HTTP transport (ADR-0391) instead; `command` may then be empty.
 *  Both carriers are mutually exclusive in practice — `url`, when present,
 *  takes precedence. */
export interface McpServerConfig {
  /** Logical name for diagnostics/log correlation. */
  name: string
  /** argv to spawn (e.g. `["bun", "server.ts"]`). Empty when a `url` is set. */
  command: string[]
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string
  /** Extra env merged over a minimal base. The full parent process env is
   *  intentionally NOT inherited so host secrets never leak to the server.
   *  Stdio carrier only. */
  env?: Record<string, string>
  /** Streamable-HTTP endpoint URL. When present, the client uses the HTTP+SSE
   *  carrier (ADR-0391) instead of spawning `command`. Omitting it keeps the
   *  byte-identical stdio default. */
  url?: string
  /** Static headers merged into every HTTP request (e.g. `Authorization`).
   *  HTTP carrier only. */
  headers?: Record<string, string>
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
