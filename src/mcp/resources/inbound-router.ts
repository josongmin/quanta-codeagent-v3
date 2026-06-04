/** H19 — inbound `roots/list` request router (server → client).
 *
 *  A connected MCP server can ask the client which filesystem roots the agent
 *  is operating in (`roots/list`, MCP spec 2025-06-18). This router turns that
 *  inbound request into a {@link RootsProviderPort} call and shapes the
 *  JSON-RPC RESULT (`{ roots: [...] }`).
 *
 *  Mirrors `@/mcp/sampling/inbound-router`: a narrow `is*Method` guard and a
 *  total `route*` that never throws. Unlike sampling there is no "decline" — a
 *  client that advertises `roots` always answers; with no provider wired the
 *  method is simply not advertised and a well-behaved server never asks. A
 *  misbehaving server that asks anyway gets an EMPTY-roots result rather than a
 *  dropped request or a `-32601` (we recognize the method, we just have nothing
 *  to report).
 */

import type { McpRoot, RootsProviderPort } from "./port"

/** MCP spec method the server uses to ask the client for its roots. */
export const MCP_ROOTS_LIST_METHOD = "roots/list"

/** Returns true iff `method` is the inbound roots request this router handles. */
export const isRootsMethod = (method: string): boolean => method === MCP_ROOTS_LIST_METHOD

/** Sanitize one root: keep only well-typed `uri`/`name` so a buggy provider
 *  can never put a non-string onto the wire. A root without a string `uri` is
 *  dropped (the `uri` is mandatory per spec). */
const sanitizeRoot = (r: McpRoot): { uri: string; name?: string } | null => {
  if (typeof r.uri !== "string" || r.uri === "") return null
  return r.name !== undefined && typeof r.name === "string"
    ? { uri: r.uri, name: r.name }
    : { uri: r.uri }
}

/** The closed JSON-RPC `result` we hand back for `roots/list`. */
export interface RootsListResponse {
  readonly roots: ReadonlyArray<{ uri: string; name?: string }>
}

/** Route an inbound `roots/list` request onto `provider`, returning the
 *  JSON-RPC `result` payload. Never throws: a provider that throws (the
 *  contract says it should not) is mapped to an empty roots list rather than
 *  left dropping the request. */
export const routeRootsList = (provider: RootsProviderPort, method: string): RootsListResponse => {
  if (method !== MCP_ROOTS_LIST_METHOD) return { roots: [] }
  let raw: ReadonlyArray<McpRoot>
  try {
    raw = provider.listRoots()
  } catch {
    // Defensive: the port contract is sync + total, but a custom impl that
    // throws must still get a well-defined answer.
    return { roots: [] }
  }
  const roots: Array<{ uri: string; name?: string }> = []
  for (const r of raw) {
    const clean = sanitizeRoot(r)
    if (clean !== null) roots.push(clean)
  }
  return { roots }
}
