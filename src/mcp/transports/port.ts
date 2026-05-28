/** Transport port for the MCP client (ADR-0391).
 *
 *  `McpClient` (../client.ts) speaks newline-delimited JSON-RPC 2.0 but the
 *  *carriage* of those messages — a spawned subprocess over stdio, or an HTTP
 *  POST + SSE stream — is an implementation detail behind this port. The client
 *  core (request/dispatch/pending/timeout) is transport-agnostic and only ever
 *  touches a {@link McpTransport}.
 *
 *  Framing ownership: a transport receives a structured `payload` to `send`
 *  (it encodes via `../jsonrpc.ts` `encodeMessage` if its wire format is the
 *  newline-delimited one) and hands back already-decoded {@link JsonRpcMessage}
 *  values via the `onMessage` handler. This keeps `encodeMessage`/`LineReader`
 *  coupling *inside* the transport instead of leaking into the client.
 *
 *  Slice fence: this module mirrors the shape of `@/ipc` `SessionTransport`
 *  (send/onMessage/close) but MUST NOT import it — IPC and MCP stay decoupled
 *  (RFC §3.1). The mirror is intentional convergence, not a dependency. */

import type { JsonRpcMessage } from "../jsonrpc"

/** A raw JSON-RPC value handed to {@link McpTransport.send}. The transport owns
 *  encoding; the client only ever passes the structured object. */
export type McpTransportPayload = unknown

/** Called for every fully-decoded inbound JSON-RPC message. */
export type McpTransportMessageHandler = (message: JsonRpcMessage) => void

/** Called once when the underlying carrier terminates (process exit, stream
 *  end, HTTP connection close). Lets the client fail all pending requests. The
 *  reason string is best-effort diagnostic detail. */
export type McpTransportExitHandler = (reason?: string) => void

/** The carriage abstraction for one MCP server connection.
 *
 *  Lifecycle: `start()` → (`send` / inbound via `onMessage`)* → `close()`.
 *  Implementations MUST be safe to `close()` more than once (idempotent) and
 *  MUST invoke the exit handler exactly once when the carrier dies. */
export interface McpTransport {
  /** Open the carrier (spawn the process / open the SSE stream). Resolves once
   *  the transport is ready to `send`; rejects if the carrier cannot be
   *  established. */
  start(): Promise<void>

  /** Register the inbound-message handler. The transport calls it for every
   *  decoded JSON-RPC message. Returns an unsubscribe function. */
  onMessage(handler: McpTransportMessageHandler): () => void

  /** Register the carrier-exit handler. Invoked exactly once when the carrier
   *  terminates. Returns an unsubscribe function. */
  onExit(handler: McpTransportExitHandler): () => void

  /** Write one JSON-RPC payload. Returns `null` on success, or an `Error`
   *  describing why the message could not be enqueued (carrier unavailable,
   *  write threw). The client treats a returned error as an immediate
   *  request failure — it never throws. */
  send(payload: McpTransportPayload): Error | null

  /** Terminate the carrier. Idempotent; resolves once teardown is complete. */
  close(): Promise<void>
}
