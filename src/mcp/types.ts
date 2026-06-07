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
  /** §1.2 (ticket-09) — SSE resume seed. The reconnect supervisor stamps the
   *  dying transport's last SSE event id here when it mints the replacement, so
   *  the new standalone GET sends `Last-Event-ID` and the server replays missed
   *  server→client messages. Omitted ⇒ fresh connect (byte-identical). HTTP only. */
  resumeFromEventId?: string
  /** H18 — per-server OAuth opt-in. When `true` AND an `oauthProvider` is wired
   *  into the `McpClient`, the client resolves a bearer token (RFC 8414
   *  discovery → DCR → PKCE browser flow → token, with RFC 6749 §6 refresh) and
   *  attaches `Authorization: Bearer <token>` to every HTTP request to this
   *  server. Omitted/false ⇒ byte-identical to the pre-H18 client: no discovery,
   *  no flow, no header. HTTP carrier only (a `url` must be set). */
  oauth?: boolean
  /** §19.1 — host-declared per-server TRUST. The single signal that authorizes
   *  the bridge to HONOR a server's self-declared `ToolAnnotations` (read-only /
   *  idempotent hints) when the `QUANTA_MCP_TOOL_ANNOTATIONS` knob is ALSO on.
   *
   *  SECURITY: annotations are SELF-DECLARED by the server, so an UNTRUSTED
   *  server's `readOnlyHint:true` must NEVER relax a permission/concurrency
   *  predicate (a hostile server would set it to escape HITL + run in parallel).
   *  Omitted/false ⇒ the server is untrusted ⇒ annotations can only ever leave
   *  the predicates at the conservative `false/false` (byte-identical to the
   *  pre-annotation bridge). Set to `true` ONLY for first-party / operator-vetted
   *  servers. Trust here can only ELEVATE, never downgrade. */
  trusted?: boolean
}

/** §19.1 — MCP `ToolAnnotations` (spec 2025-06-18). Every field is an UNTRUSTED
 *  hint the server self-declares — advisory only, NEVER trusted to relax a
 *  security predicate unless BOTH the default-OFF knob is set AND the server is
 *  explicitly host-trusted (see `@/agent` mcp-bridge `honored`). A field is
 *  carried ONLY when it arrived as a real JSON boolean; a poisoned non-boolean
 *  value (`"true"`, `1`, `{}`, `null`) is dropped at parse time so it can never
 *  be truthy-coerced downstream. */
export interface McpToolAnnotations {
  /** Human-friendly title (display only; no security meaning). */
  title?: string
  /** Server claims the tool does not modify its environment. */
  readOnlyHint?: boolean
  /** Server claims the tool may perform destructive updates. */
  destructiveHint?: boolean
  /** Server claims repeated calls with the same args have no additional effect. */
  idempotentHint?: boolean
  /** Server claims the tool interacts with an open world (e.g. the internet). */
  openWorldHint?: boolean
}

/** A tool advertised by the server's `tools/list`. */
export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** §19.1 — sanitized, boolean-only annotations the server advertised. Absent
   *  when the server sent none OR every advertised field was poisoned
   *  (non-boolean). Carrying it does NOT change any predicate by itself — the
   *  bridge only ever CONSULTS it under a trust gate + knob (default-OFF). */
  annotations?: McpToolAnnotations
}

/** §19.3 — a non-text content block surfaced from a `tools/call` result. An
 *  `image` block carries base64 `data` + `mimeType`; an embedded `resource`
 *  block (a blob resource) becomes a native document. Bounded + magic-checked at
 *  the bridge (where the `@/tool` 5 MB image cap is reachable) before reaching
 *  the model — the `@/mcp` slice stays a pure shape extractor (no `@/tool`
 *  import, RFC §3.1). */
export interface McpMediaBlock {
  kind: "image" | "resource"
  /** Base64 payload (image data, or embedded-resource blob). */
  data: string
  /** IANA media type advertised by the server (validated downstream). */
  mimeType: string
}

/** Outcome of a `tools/call`. `content` is every text content block joined by
 *  newlines; `ok` is false when the server set `result.isError`. */
export interface McpCallResult {
  ok: boolean
  content: string
  /** §19.3 — non-text content blocks (image / embedded resource) the server
   *  returned. OPTIONAL: absent (or empty) when the server returned only text,
   *  so the legacy text-only result is byte-identical and every existing
   *  consumer (which reads only `ok`/`content`) is unaffected. The bridge maps
   *  these to `ToolResult.images` / `ToolResult.documents` after the inbound
   *  size cap + magic-byte sniff. */
  media?: McpMediaBlock[]
  /** §19.2 — the server's typed `structuredContent` payload, carried opaque.
   *  OPTIONAL: absent when the server returned only text/`content`, so the
   *  legacy result is byte-identical. The bridge maps it onto
   *  `ToolResult.structured` so a model/consumer can read the typed shape. */
  structured?: unknown
}
