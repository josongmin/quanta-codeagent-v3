/**
 * Protocol-neutral JSON-RPC 2.0 envelope types and the live MCP/LSP
 * acceptance guard.
 *
 * Framing, byte caps, and transport recovery stay in `@/mcp` and `@/lsp`.
 * This module freezes the CURRENT shared acceptance contract: it does not
 * tighten id-null, result+error exclusivity, or version handling relative to
 * the pre-extraction MCP/LSP `isValidEnvelope` copies.
 */

export type JsonRpcId = string | number

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export type JsonRpcEnvelope =
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: JsonRpcErrorObject }

/**
 * Live MCP/LSP envelope acceptance. A message is valid when it is a
 * non-null object with `jsonrpc === "2.0"` and at least one of `id` or
 * `method`, with typed `id`/`method` when present. Result+error coexistence
 * is accepted (both adapters historically allowed it).
 */
export const isJsonRpcEnvelope = (value: unknown): value is JsonRpcEnvelope => {
  if (typeof value !== "object" || value === null) return false
  const o = value as Record<string, unknown>
  if (o.jsonrpc !== "2.0") return false
  const hasId = "id" in o
  const hasMethod = "method" in o
  if (!hasId && !hasMethod) return false
  if (hasId) {
    const id = o.id
    if (typeof id !== "string" && typeof id !== "number") return false
  }
  if (hasMethod && typeof o.method !== "string") return false
  return true
}
