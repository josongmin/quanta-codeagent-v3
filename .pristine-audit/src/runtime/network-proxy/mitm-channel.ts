/**
 * jun-7 TLS-MITM — the TLS-termination CHANNEL abstraction (runtime seam).
 *
 * The proxy must, on an allowed `CONNECT host:443` with MITM enabled, TERMINATE
 * TLS on the CONNECT-upgraded socket (presenting a leaf the agent's client
 * trusts), READ exactly one decrypted HTTP request, scan it, then WRITE a
 * (re-encrypted) response back to the client. HOW that termination is driven is
 * runtime-specific:
 *
 *   - **node:tls** (`./mitm-channel-node.ts`) — wrap the raw socket in a
 *     server-side `TLSSocket`. Node delivers the ClientHello to a server-wrapped
 *     existing socket, so this Just Works.
 *   - **Bun** (`./mitm-channel-bun.ts`) — Bun 1.3.x does NOT deliver the
 *     ClientHello to a server-wrapped raw socket, so the node:tls path stalls.
 *     Instead we run a one-shot `Bun.listen({ tls })` terminator on an ephemeral
 *     loopback port and BYTE-PIPE the raw CONNECT socket to it; the terminator
 *     decrypts and we parse the plaintext, writing the response back through it
 *     (re-encrypted). An EMPIRICAL spike (jun-07) confirmed this completes a real
 *     handshake on Bun 1.3.14 and surfaces the decrypted bytes.
 *
 * Both implementations expose the SAME {@link MitmTlsChannel}, so the proxy's
 * scan + upstream-forward logic (`loopback-proxy.ts`) is transport-agnostic and
 * the security model (ephemeral CA, fail-closed, upstream `rejectUnauthorized`)
 * is defined ONCE.
 *
 * This module is types + the capability-detecting factory only; the I/O lives in
 * the two adapter files.
 */

import type { IncomingHttpHeaders } from "node:http"
import type { Socket } from "node:net"
import type { LeafCert } from "./mitm-cert"

/** A single decrypted HTTP request parsed off a terminated TLS-MITM channel.
 *  Identical shape across runtimes so the scan/forward path is shared. */
export interface ParsedTlsRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  /** Header values concatenated for the secret scan (names are not secrets). */
  readonly headerText: string
  /** The buffered request body, CAPPED at the scan budget (a body past the cap is
   *  truncated here — never fully held in memory — and {@link bodyOverCap} set so
   *  the caller forwards UNSCANNED / fails closed rather than scanning a partial
   *  body). */
  readonly body: Buffer
  /** True IFF the decrypted body exceeded the scan cap (so it was NOT fully
   *  buffered). The caller fails closed. */
  readonly bodyOverCap: boolean
}

/**
 * A terminated TLS-MITM channel: TLS is (being) terminated against our leaf, and
 * the proxy reads one decrypted request + writes a re-encrypted response. ALL
 * methods are NO-THROW (a runtime that cannot complete the handshake surfaces as
 * `parse()` resolving `null` / a write returning `false`, never a throw) so the
 * proxy's fail-closed handler always runs.
 */
export interface MitmTlsChannel {
  /**
   * Resolve with the ONE decrypted HTTP request parsed off the channel, or `null`
   * on a parse error / premature close. The body is buffered with a STREAMING cap
   * (`maxBodyBytes`) so a huge decrypted body can NEVER be fully held in memory.
   * NEVER rejects — a stuck handshake resolves `null` (and the proxy's watchdog
   * timer also guards it).
   */
  parse(maxBodyBytes: number): Promise<ParsedTlsRequest | null>
  /** True IFF the channel can still accept a response write. */
  writable(): boolean
  /** Write response bytes back to the client (re-encrypted). Returns `false` on
   *  any error / non-writable channel so the caller can hard-destroy. NO-THROW. */
  write(chunk: Buffer | string): boolean
  /** Finish the response (optionally writing a final chunk) + close. NO-THROW. */
  end(chunk?: Buffer | string): void
  /** Hard-destroy the channel (fail-closed). NO-THROW. */
  destroy(): void
}

/**
 * The runtime seam: open a terminated TLS-MITM channel for `clientSocket`,
 * presenting `leaf`. Returns `null` synchronously if the runtime cannot drive
 * termination at all (so the caller fails closed immediately). The channel's
 * `parse()` then drives the handshake + request read.
 */
export type OpenMitmChannel = (clientSocket: Socket, leaf: LeafCert) => MitmTlsChannel | null

/** Is the host runtime Bun? `globalThis.Bun` is the documented Bun marker (same
 *  detection the otel-resource + webhook-transport slices use). */
export const isBunRuntime = (): boolean =>
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/**
 * Parse a raw decrypted HTTP/1.1 request buffer into the shared
 * {@link ParsedTlsRequest} shape. Content-Length framing only (the MITM only
 * ever sees ONE request per CONNECT and we forward it whole); a chunked body or
 * a body past `maxBodyBytes` sets {@link ParsedTlsRequest.bodyOverCap} so the
 * caller fails closed. Returns `null` until the full header block has arrived,
 * `{ done:false }` while waiting for more body, the parsed request when complete.
 *
 * Shared by the Bun adapter (which has no node:http parser available — Bun's
 * `http.Server.emit("connection", ...)` does NOT drive parsing, proven by the
 * jun-07 spike — so it parses the decrypted bytes directly) and unit-tested in
 * isolation. PURE / NO-THROW.
 */
export interface ManualParseState {
  /** True once a complete request (headers + framed body) has been parsed. */
  readonly done: boolean
  /** The parsed request (only when `done`). */
  readonly request?: ParsedTlsRequest
}

const CRLFCRLF = Buffer.from("\r\n\r\n")

/** The parsed request line + headers (no body yet). */
interface ParsedHead {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly headerValues: string[]
}

/** Parse the request line + header lines of an HTTP/1.1 request block. PURE. */
const parseHead = (headerText: string): ParsedHead => {
  const lines = headerText.split("\r\n")
  const reqParts = (lines[0] ?? "").split(" ")
  const method = (reqParts[0] ?? "GET").toUpperCase()
  const rawPath = reqParts[1] ?? "/"
  const headers: IncomingHttpHeaders = {}
  const headerValues: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    // Multiple headers with the same name: keep an array (node:http convention).
    const existing = headers[name]
    if (existing === undefined) headers[name] = value
    else if (Array.isArray(existing)) existing.push(value)
    else headers[name] = [existing, value]
    headerValues.push(value)
  }
  // Path normalization mirrors the node:tls path (`new URL(...).pathname+search`).
  let path = rawPath
  try {
    const url = new URL(rawPath, "http://placeholder")
    path = url.pathname + url.search
  } catch {
    // keep rawPath
  }
  return { method, path, headers, headerValues }
}

/** Resolve the framed Content-Length, or `null` if the body cannot be safely
 *  framed/scanned (chunked / malformed / over the cap) ⇒ the caller fails closed. */
const framedContentLength = (head: ParsedHead, maxBodyBytes: number): number | null => {
  // A chunked body has no content-length: we cannot frame it here, so fail closed.
  if (head.headers["transfer-encoding"] !== undefined) return null
  const clenRaw = head.headers["content-length"]
  const clenStr = Array.isArray(clenRaw) ? clenRaw[0] : clenRaw
  const contentLength = clenStr !== undefined ? Number(clenStr) : 0
  if (!Number.isInteger(contentLength) || contentLength < 0) return null // malformed
  if (contentLength > maxBodyBytes) return null // over the scan cap — never buffer whole
  return contentLength
}

export const parseHttpRequestBuffer = (buf: Buffer, maxBodyBytes: number): ManualParseState => {
  const headerEnd = buf.indexOf(CRLFCRLF)
  if (headerEnd === -1) {
    // Header block not complete yet — but guard against an unbounded header DoS:
    // if we've already accumulated more than the cap with NO header terminator,
    // treat it as over-cap (fail closed) rather than buffering forever.
    if (buf.length > maxBodyBytes) return { done: true, request: overCapRequest() }
    return { done: false }
  }
  const head = parseHead(buf.subarray(0, headerEnd).toString("utf8"))
  const contentLength = framedContentLength(head, maxBodyBytes)
  if (contentLength === null) {
    return {
      done: true,
      request: overCapRequest(head.method, head.path, head.headers, head.headerValues),
    }
  }
  const bodyStart = headerEnd + CRLFCRLF.length
  if (buf.length - bodyStart < contentLength) return { done: false } // wait for the rest
  return {
    done: true,
    request: {
      method: head.method,
      path: head.path,
      headers: head.headers,
      headerText: head.headerValues.join("\n"),
      body: Buffer.from(buf.subarray(bodyStart, bodyStart + contentLength)),
      bodyOverCap: false,
    },
  }
}

/** An over-cap / unframable request marker — `bodyOverCap` set so the caller
 *  fails closed (cannot scan a partial body / cannot frame a chunked one). */
const overCapRequest = (
  method = "GET",
  path = "/",
  headers: IncomingHttpHeaders = {},
  headerValues: string[] = [],
): ParsedTlsRequest => ({
  method,
  path,
  headers,
  headerText: headerValues.join("\n"),
  body: Buffer.alloc(0),
  bodyOverCap: true,
})
