/** H18 (jun-04) — closed-port for MCP HTTP-server OAuth (RFC 8414 discovery →
 *  RFC 7591 DCR → PKCE browser flow → bearer, with RFC 6749 §6 refresh).
 *
 *  ## Why a port (the same DI principle as `SamplingHandlerPort`)
 *
 *  An MCP server reached over HTTP may require OAuth bearer auth. Performing the
 *  flow needs RFC 8414 discovery, dynamic client registration, a loopback +
 *  PKCE browser flow, a token store, and refresh scheduling — all of which live
 *  in `@/connectors` and `@/auth`. But `@/mcp` MUST NOT import those slices
 *  (slice isolation, RFC §3.1: `@/mcp` depends on `@/shared` only). So the
 *  capability arrives through THIS port, wired at the composition root (the only
 *  layer allowed to reach both `@/mcp` and `@/connectors`). The connectors-backed
 *  implementation lives in `@/host/runtime/mcp-oauth-provider`.
 *
 *  ## Contract (advertise-iff-able / opt-in / total)
 *
 *  The client consults the port ONLY when a server config opts in (`oauth: true`)
 *  AND a provider is wired. When no provider is wired (the default) the client is
 *  byte-identical to the pre-H18 path: no discovery, no flow, no header. The port
 *  is TOTAL — `tokenFor` resolves `undefined` (not throws) when no token can be
 *  obtained, so a failed/declined login degrades to an unauthenticated request
 *  (the server answers 401, surfaced like any other error) rather than crashing
 *  the load. Tokens are returned as opaque strings and MUST NEVER be logged.
 */

export interface McpOAuthProviderPort {
  /** Resolve the current bearer access token for `serverName`, running the
   *  full discovery → (DCR) → PKCE browser flow on first use, reusing a stored
   *  unexpired token, and refreshing (RFC 6749 §6) or re-authorizing on expiry.
   *  Resolves `undefined` when no token can be obtained (login declined/failed)
   *  — the contract is total, never throwing out into the MCP load path. */
  tokenFor(serverName: string): Promise<string | undefined>
  /** Forget the cached/stored token for `serverName` so the next `tokenFor`
   *  re-authorizes. Called on a 401 against a server we believed was
   *  authenticated (the token was revoked server-side). Idempotent. */
  invalidate(serverName: string): Promise<void>
}
