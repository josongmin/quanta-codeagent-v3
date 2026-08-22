/**
 * jun-7 TLS-MITM — node:tls TLS-termination channel (the original mechanism,
 * hoisted behind {@link MitmTlsChannel}).
 *
 * Wraps the raw CONNECT-upgraded socket in a SERVER-side `TLSSocket` presenting
 * the minted leaf, then parses one decrypted HTTP request off it by running a
 * one-shot in-process `http.Server` over the TLS socket (`emit("connection")`).
 * Node delivers the ClientHello to a server-wrapped existing socket, so the
 * handshake completes; the response is written back over the SAME TLS socket
 * (re-encrypted).
 *
 * This is exactly the pre-jun-07 mechanism, now behind the channel seam so the
 * proxy's scan/forward logic is runtime-agnostic. Works on Node; on Bun the
 * `Bun.listen` bridge (`./mitm-channel-bun.ts`) is used instead (Bun does not
 * drive server-side TLS on a CONNECT-upgraded socket, nor parse via
 * `emit("connection")` — proven by the jun-07 spike).
 */

import { createServer } from "node:http"
import type { Socket } from "node:net"
import { createSecureContext, TLSSocket, type TLSSocket as TLSSocketType } from "node:tls"
import type { MitmTlsChannel, OpenMitmChannel, ParsedTlsRequest } from "./mitm-channel"
import { readCappedBody } from "./read-capped-body"

/** A node:tls-backed MITM channel. */
class NodeTlsChannel implements MitmTlsChannel {
  constructor(
    private readonly tls: TLSSocketType,
    private readonly headerScanText: (headers: Record<string, unknown>) => string,
  ) {}

  parse(maxBodyBytes: number): Promise<ParsedTlsRequest | null> {
    return new Promise((resolve) => {
      let settled = false
      const done = (v: ParsedTlsRequest | null): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      const innerServer = createServer((req, _res) => {
        // STREAMING cap (DoS parity): a huge decrypted body is never fully held.
        void readCappedBody(req, maxBodyBytes).then(({ body, overCap }) => {
          const url = new URL(req.url ?? "/", "http://placeholder")
          done({
            method: req.method ?? "GET",
            path: url.pathname + url.search,
            headers: req.headers,
            headerText: this.headerScanText(req.headers as Record<string, unknown>),
            body,
            bodyOverCap: overCap,
          })
        })
        req.on("error", () => done(null))
      })
      innerServer.on("clientError", () => done(null))
      // Feed the already-accepted TLS socket into the HTTP parser.
      innerServer.emit("connection", this.tls)
      this.tls.on("error", () => done(null))
      this.tls.on("close", () => done(null))
    })
  }

  writable(): boolean {
    return this.tls.writable
  }

  write(chunk: Buffer | string): boolean {
    if (!this.tls.writable) return false
    try {
      this.tls.write(chunk)
      return true
    } catch {
      return false
    }
  }

  end(chunk?: Buffer | string): void {
    try {
      if (chunk !== undefined) this.tls.end(chunk)
      else this.tls.end()
    } catch {
      this.destroy()
    }
  }

  destroy(): void {
    try {
      if (!this.tls.destroyed) this.tls.destroy()
    } catch {
      // already gone
    }
  }
}

/** Open a node:tls MITM channel. `headerScanText` is injected from the proxy so
 *  the header-blob construction matches the plaintext path exactly. */
export const makeNodeMitmChannelOpener =
  (headerScanText: (headers: Record<string, unknown>) => string): OpenMitmChannel =>
  (clientSocket: Socket, leaf): MitmTlsChannel | null => {
    let tls: TLSSocketType
    try {
      tls = new TLSSocket(clientSocket, {
        isServer: true,
        secureContext: createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }),
      })
    } catch {
      return null // context build failed ⇒ caller fails closed
    }
    return new NodeTlsChannel(tls, headerScanText)
  }
