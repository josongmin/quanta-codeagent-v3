/**
 * jun-7 TLS-MITM — Bun.listen TLS-terminator BRIDGE channel.
 *
 * WHY: Bun 1.3.x cannot drive a SERVER-side TLS handshake on a socket obtained
 * from an HTTP `connect` event (the ClientHello never reaches a server-wrapped
 * raw socket), so the node:tls termination (`./mitm-channel-node.ts`) stalls on
 * Bun and the proxy's watchdog can only DENY (safe but non-functional). The
 * jun-07 spike PROVED a working alternative on Bun 1.3.14:
 *
 *   1. mint the leaf for `host` (the EXISTING ephemeral CA),
 *   2. start a ONE-SHOT `Bun.listen({ tls:{ cert, key } })` terminator on an
 *      ephemeral 127.0.0.1 port (Bun-native TLS server — terminates fine),
 *   3. BYTE-PIPE the raw CONNECT socket to that terminator over a plain
 *      `net.connect` socket. The client's ClientHello (carried over the pipe)
 *      reaches the Bun TLS server, the handshake COMPLETES, and the terminator's
 *      `socket.data` callback delivers the DECRYPTED plaintext.
 *   4. parse the plaintext HTTP request MANUALLY (Bun's
 *      `http.Server.emit("connection")` does NOT drive parsing — also proven by
 *      the spike — so we cannot reuse the node:http parser here), then write the
 *      (re-encrypted) response back through the terminator socket.
 *
 * SECURITY — the bridge changes NOTHING about the trust model:
 *   - the leaf is signed by the SAME ephemeral, in-memory, single-consumer CA;
 *   - the loopback terminator binds 127.0.0.1:0 (never routable) and lives only
 *     for this one CONNECT — it is NOT a persistent listener, NOT on the OS trust
 *     store, and carries ONLY this connection's bytes;
 *   - upstream verification is unchanged (the proxy's `mitmForwardUpstream` still
 *     dials the REAL host with `rejectUnauthorized:true` — this file never
 *     touches the upstream leg);
 *   - FAIL-CLOSED: any bridge/handshake/parse error resolves `parse()` to `null`
 *     (the proxy then denies / opaque-tunnels per `onFailure`), and the proxy's
 *     watchdog timer still bounds a stuck handshake. NO-THROW throughout.
 *
 * This file is the ONE Bun-API boundary in the slice (gated behind
 * {@link isBunRuntime}); it is structurally typed so it stays importable under
 * node-only test contexts (the `Bun.listen`/`net` calls only run on Bun).
 */

import { connect as netConnect, type Socket } from "node:net"
import {
  isBunRuntime,
  type MitmTlsChannel,
  type OpenMitmChannel,
  type ParsedTlsRequest,
  parseHttpRequestBuffer,
} from "./mitm-channel"

/** Minimal structural shape of a Bun socket (the handler's `socket` arg). */
interface BunSocketLike {
  write(data: Buffer | string | Uint8Array): number
  end(data?: Buffer | string | Uint8Array): void
  flush?(): void
}

/** Minimal structural shape of the Bun.listen server handle. */
interface BunListenerLike {
  readonly port: number
  stop(closeActiveConnections?: boolean): void
}

interface BunListenOptions {
  hostname: string
  port: number
  tls: { cert: string; key: string }
  socket: {
    open?(socket: BunSocketLike): void
    data?(socket: BunSocketLike, data: Buffer): void
    close?(socket: BunSocketLike): void
    error?(socket: BunSocketLike, err: Error): void
  }
}

interface BunRuntimeLike {
  listen(opts: BunListenOptions): BunListenerLike
}

/** Resolve the Bun runtime if `Bun.listen` is available (else `undefined`). */
const resolveBun = (): BunRuntimeLike | undefined => {
  const g = globalThis as { Bun?: BunRuntimeLike }
  if (g.Bun === undefined) return undefined
  if (typeof g.Bun.listen !== "function") return undefined
  return g.Bun
}

/**
 * A Bun-bridge MITM channel. The terminator + the plain bridge socket are
 * created in `open`; `parse()` wires the byte-pipe and resolves the decrypted
 * request. Writes go to the terminator socket (re-encrypted to the client).
 */
class BunBridgeChannel implements MitmTlsChannel {
  private termSocket: BunSocketLike | null = null
  private listener: BunListenerLike | null = null
  private bridge: Socket | null = null
  private acc: Buffer = Buffer.alloc(0)
  private settled = false
  private closed = false
  /** Bytes from the raw client that arrived BEFORE the bridge was connected.
   *  Captured synchronously at construction so the ClientHello (which the client
   *  sends the instant it sees `200 Connection Established`) is never lost to a
   *  late `data` listener — the race that made the first handshake stall. */
  private pending: Buffer[] = []
  private bridgeReady = false

  constructor(
    private readonly bun: BunRuntimeLike,
    private readonly clientSocket: Socket,
    private readonly leaf: { certPem: string; keyPem: string },
  ) {
    // Attach the raw-client reader IMMEDIATELY (in the same tick the proxy creates
    // the channel, right after it wrote `200 Connection Established`). Buffer until
    // the bridge is up, then flush in order.
    this.clientSocket.on("data", (c: Buffer) => this.fromClient(c))
    this.clientSocket.on("error", () => this.fail())
    this.clientSocket.on("end", () => {
      if (this.bridge !== null && !this.bridge.destroyed) this.bridge.end()
    })
  }

  /** Raw client bytes → bridge (buffered until the bridge connects). */
  private fromClient(c: Buffer): void {
    if (this.bridgeReady && this.bridge !== null && !this.bridge.destroyed) {
      this.bridge.write(c)
    } else {
      this.pending.push(c)
    }
  }

  private failResolve: ((v: ParsedTlsRequest | null) => void) | null = null
  private fail(): void {
    this.failResolve?.(null)
  }

  parse(maxBodyBytes: number): Promise<ParsedTlsRequest | null> {
    return new Promise<ParsedTlsRequest | null>((resolve) => {
      const done = (v: ParsedTlsRequest | null): void => {
        if (this.settled) return
        this.settled = true
        resolve(v)
      }
      this.failResolve = done // a raw-client error after this point fails closed

      let listener: BunListenerLike
      try {
        listener = this.bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          tls: { cert: this.leaf.certPem, key: this.leaf.keyPem },
          socket: {
            open: (s) => {
              this.termSocket = s
            },
            data: (_s, data) => {
              // Accumulate decrypted plaintext + try to parse one full request.
              this.acc = Buffer.concat([this.acc, data])
              const state = parseHttpRequestBuffer(this.acc, maxBodyBytes)
              if (state.done) done(state.request ?? null)
            },
            close: () => done(null), // closed before a full request ⇒ fail closed
            error: () => done(null),
          },
        })
      } catch {
        done(null)
        return
      }
      this.listener = listener

      // Plain TCP bridge carrying the client's TLS bytes to the terminator.
      let bridge: Socket
      try {
        bridge = netConnect(listener.port, "127.0.0.1")
      } catch {
        done(null)
        return
      }
      this.bridge = bridge

      bridge.on("connect", () => {
        this.bridgeReady = true
        // Flush any client bytes (the ClientHello) buffered before connect.
        for (const c of this.pending) {
          if (!bridge.destroyed) bridge.write(c)
        }
        this.pending = []
      })
      // terminator (encrypted output) -> bridge -> raw client
      bridge.on("data", (c: Buffer) => {
        if (this.clientSocket.writable) this.clientSocket.write(c)
      })
      bridge.on("end", () => {
        if (this.clientSocket.writable) this.clientSocket.end()
      })
      bridge.on("error", () => done(null))
      // End-of-response: when either side closes the bridge, reap the one-shot
      // terminator (this is the natural teardown signal after `end()` half-closed
      // the TLS socket and the encrypted close_notify reached the client).
      bridge.on("close", () => this.teardown())
      this.clientSocket.on("close", () => this.teardown())
    })
  }

  writable(): boolean {
    return this.termSocket !== null && !this.closed
  }

  write(chunk: Buffer | string): boolean {
    if (this.termSocket === null || this.closed) return false
    try {
      this.termSocket.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
      this.termSocket.flush?.()
      return true
    } catch {
      return false
    }
  }

  end(chunk?: Buffer | string): void {
    // Write the final chunk + half-close the TLS terminator so its encrypted
    // close_notify + buffered response bytes FLUSH to the bridge → client. We do
    // NOT tear down the listener here — that would `stop(true)` and drop the
    // in-flight encrypted bytes before they reach the client (the response-loss
    // bug). Teardown runs when the bridge/client side closes (or destroy()).
    if (this.termSocket !== null && !this.closed) {
      try {
        if (chunk !== undefined)
          this.termSocket.end(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        else this.termSocket.end()
        this.termSocket.flush?.()
      } catch {
        this.teardown()
        return
      }
      // The one-shot listener + bridge are reaped when the client/bridge socket
      // CLOSES (wired in `parse`) — the natural end-of-response signal — so the
      // encrypted bytes are never dropped and no magic timeout is needed.
      return
    }
    this.teardown()
  }

  destroy(): void {
    this.teardown()
  }

  /** Stop the one-shot terminator + tear down the bridge + raw socket. NO-THROW. */
  private teardown(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.listener?.stop(true)
    } catch {
      // best-effort
    }
    try {
      if (this.bridge !== null && !this.bridge.destroyed) this.bridge.destroy()
    } catch {
      // best-effort
    }
    try {
      if (!this.clientSocket.destroyed) this.clientSocket.destroy()
    } catch {
      // best-effort
    }
  }
}

/**
 * Open a Bun-bridge MITM channel. Returns `null` if not running under Bun (the
 * caller then uses the node:tls opener). The handshake + decrypt is driven by
 * `parse()`.
 */
export const openBunMitmChannel: OpenMitmChannel = (clientSocket, leaf) => {
  if (!isBunRuntime()) return null
  const bun = resolveBun()
  if (bun === undefined) return null
  return new BunBridgeChannel(bun, clientSocket, leaf)
}
