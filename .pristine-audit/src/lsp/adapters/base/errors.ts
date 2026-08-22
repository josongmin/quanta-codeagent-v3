import type { JsonRpcError } from "../jsonrpc"

/** A JSON-RPC error raised by a server response. Preserves the wire `code`
 *  so call sites can distinguish "method not supported" (-32601) from other
 *  failures without re-parsing the message. */
export class LspRequestError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(method: string, err: JsonRpcError) {
    super(`LSP error in "${method}": ${err.message}`)
    this.name = "LspRequestError"
    this.code = err.code
    if (err.data !== undefined) this.data = err.data
  }
}

/** Detect a "method not supported" JSON-RPC error so the nav RPCs can surface
 *  `null` (capability missing) instead of throwing — per the LspPort contract. */
export const isUnsupportedError = (e: unknown): boolean => {
  if (!(e instanceof LspRequestError)) return false
  if (e.code === -32601 || e.code === -32602) return true
  const m = e.message.toLowerCase()
  return m.includes("not supported") || m.includes("unsupported")
}
