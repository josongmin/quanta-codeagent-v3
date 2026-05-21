/** Newline-delimited JSON-RPC 2.0 codec for MCP stdio transport.
 *
 *  MCP framing is NOT LSP `Content-Length`: every message is a single line of
 *  UTF-8 JSON terminated by `\n`, with no embedded raw newlines. The framing
 *  correctness risk is the same in spirit as LSP (a server may flush several
 *  messages in one chunk, or split one message across chunks), so
 *  {@link LineReader} owns a byte buffer and only emits a message once a full
 *  `\n`-terminated line has arrived. */

import { logger } from "@/shared"

/** Raw JSON-RPC shapes we read off the wire. The spec defines more, but the
 *  client only distinguishes responses (by `id`) from notifications (by
 *  `method` without `id`). Anything else is ignored by callers. */
export type JsonRpcMessage =
  | JsonRpcResponse
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** Encode a JSON-RPC value as one newline-terminated UTF-8 line. */
export const encodeMessage = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(payload)}\n`)

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(a.byteLength + b.byteLength))
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

const NEWLINE = 0x0a

/** S15: strict JSON-RPC 2.0 envelope validator. Spec requires every message
 *  carry `jsonrpc:"2.0"` AND either an `id` (response) or a `method`
 *  (notification/request). Without this, a hostile or buggy MCP server can
 *  spoof responses with arbitrary `id`. */
const isValidEnvelope = (m: unknown): m is JsonRpcMessage => {
  if (typeof m !== "object" || m === null) return false
  const o = m as Record<string, unknown>
  if (o["jsonrpc"] !== "2.0") return false
  const hasId = "id" in o
  const hasMethod = "method" in o
  if (!hasId && !hasMethod) return false
  if (hasId) {
    const id = o["id"]
    if (typeof id !== "string" && typeof id !== "number") return false
  }
  if (hasMethod && typeof o["method"] !== "string") return false
  return true
}

/** Accumulates raw stdout bytes and yields fully-received JSON-RPC messages.
 *
 *  Handles partial reads (a line spanning chunks stays buffered), coalesced
 *  flushes (many messages per chunk), and blank lines (skipped). A line that
 *  is not valid JSON is logged and dropped so a poisoned stream cannot wedge
 *  the reader. */
export class LineReader {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))
  private readonly decoder = new TextDecoder()

  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.buffer = concat(this.buffer, chunk)
    const out: JsonRpcMessage[] = []
    let line = this.nextLine()
    while (line !== null) {
      const parsed = this.parseLine(line)
      if (parsed !== null) out.push(parsed)
      line = this.nextLine()
    }
    return out
  }

  /** Slice off the next `\n`-terminated line as text, or null if none yet. */
  private nextLine(): string | null {
    const nl = this.buffer.indexOf(NEWLINE)
    if (nl < 0) return null
    const text = this.decoder.decode(this.buffer.subarray(0, nl))
    this.buffer = this.buffer.subarray(nl + 1)
    return text
  }

  private parseLine(line: string): JsonRpcMessage | null {
    const trimmed = line.trim()
    if (trimmed.length === 0) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      logger.warn("mcp: skipping malformed JSON-RPC line", { line: trimmed.slice(0, 200) })
      return null
    }
    // S15: refuse anything that doesn't match the JSON-RPC 2.0 envelope.
    if (!isValidEnvelope(parsed)) {
      logger.warn("mcp: skipping non-jsonrpc envelope", { line: trimmed.slice(0, 200) })
      return null
    }
    return parsed
  }
}

export const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => "id" in m && !("method" in m)
