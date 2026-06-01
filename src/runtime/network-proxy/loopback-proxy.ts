/**
 * Loopback HTTP egress proxy — REAL Node `http`/`net` adapter (ADR-0428).
 *
 * Binds a forward proxy on loopback. Child processes get `HTTP_PROXY` /
 * `HTTPS_PROXY` pointed here (see `./env.ts`), so their OWN sockets are gated
 * by the SAME `isHostAllowed` decision the tool-arg dispatch guard uses —
 * closing the subprocess egress bypass.
 *
 * Two paths, both enforced by {@link decideEgress}:
 *   - Plain HTTP (`GET http://host/...`): the proxy sees an absolute-form
 *     request line. Allowed ⇒ dial the origin and pipe; denied ⇒ 403.
 *   - HTTPS via `CONNECT host:443`: the proxy can't read the (TLS) bytes, so it
 *     decides on the CONNECT authority alone. Allowed ⇒ open a raw tunnel and
 *     pipe both directions; denied ⇒ `403` status line, socket closed cleanly.
 *
 * Defense in depth: after dialing an allowed *name*, the resolved peer address
 * is re-checked against the SSRF guard (DNS-rebinding defense); a peer that
 * resolves to an internal address is dropped even though the name was allowed.
 *
 * Fail-closed: any parse failure / unexpected error ⇒ deny + clean close, never
 * a passthrough. Pure-policy is delegated to `./decision`; this file is the I/O
 * shell only.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http"
import { isIP, connect as netConnect, type Socket } from "node:net"
import { classifyHost } from "@/shared/net/ssrf"
import { NetworkPolicyAmendment } from "./amendment"
import { decideEgress, type EgressDecision } from "./decision"
import type { NetworkProxyPort } from "./port"
import type { DecisionLogEntry, NetworkProxyConfig, ProxyAddress } from "./types"

const DEFAULT_BIND_HOST = "127.0.0.1"

/**
 * Physical dial-target resolver (DI seam). Maps the policy host:port to the
 * actual socket endpoint. Production identity-maps (dial the same host:port).
 * Tests inject a resolver so a hermetic loopback origin can stand in for a
 * routable name WITHOUT weakening the SSRF guard (the post-connect peer re-check
 * still runs on the resolved address). This is a resolver shim, not a policy
 * bypass: the allow/deny DECISION is always made on the requested host.
 */
export type DialTarget = (host: string, port: number) => { host: string; port: number }
const IDENTITY_DIAL: DialTarget = (host, port) => ({ host, port })

/** Strip a `host:port` (or bracketed IPv6) authority down to the bare host. */
const bareHost = (authority: string): string => {
  const a = authority.trim().toLowerCase()
  if (a.startsWith("[")) {
    const end = a.indexOf("]")
    return end === -1 ? a : a.slice(1, end)
  }
  const colon = a.lastIndexOf(":")
  return colon === -1 ? a : a.slice(0, colon)
}

/** Parse `host:port` into a dial target. HTTP default 80, HTTPS CONNECT 443. */
const splitHostPort = (authority: string, defaultPort: number): { host: string; port: number } => {
  const host = bareHost(authority)
  const a = authority.trim()
  const idx = a.startsWith("[") ? a.indexOf("]:") + 1 : a.lastIndexOf(":")
  const portStr = idx > 0 ? a.slice(idx + 1) : ""
  const port = Number(portStr)
  return { host, port: Number.isInteger(port) && port > 0 ? port : defaultPort }
}

export class LoopbackEgressProxy implements NetworkProxyPort {
  readonly amendments: NetworkPolicyAmendment
  private readonly server: Server
  private readonly log: DecisionLogEntry[] = []
  private bound: ProxyAddress | null = null
  private readonly now: () => number

  private readonly dial: DialTarget
  /** When a DI dial-override is supplied, the post-connect peer SSRF re-check is
   *  skipped (the resolver is trusted to map to a hermetic endpoint). Production
   *  uses the identity dial ⇒ the peer re-check is always ACTIVE. */
  private readonly peerCheckActive: boolean

  constructor(
    private readonly config: NetworkProxyConfig,
    deps: { now?: () => number; amendments?: NetworkPolicyAmendment; dial?: DialTarget } = {},
  ) {
    this.now = deps.now ?? Date.now
    this.amendments = deps.amendments ?? new NetworkPolicyAmendment(this.now)
    this.dial = deps.dial ?? IDENTITY_DIAL
    this.peerCheckActive = deps.dial === undefined
    this.server = createServer((req, res) => this.onRequest(req, res))
    // The `connect` event types `socket` as `Duplex`; for a TCP CONNECT it is
    // always a `net.Socket`. Narrow it for the tunnel path.
    this.server.on("connect", (req, socket, head) => this.onConnect(req, socket as Socket, head))
    // A malformed client request must not crash the proxy process.
    this.server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
    })
  }

  listen(): Promise<ProxyAddress> {
    const host = this.config.bindHost ?? DEFAULT_BIND_HOST
    const port = this.config.port ?? 0
    return new Promise((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(port, host, () => {
        const addr = this.server.address()
        if (addr === null || typeof addr === "string") {
          reject(new Error("proxy bound to a non-TCP address"))
          return
        }
        this.bound = { host, port: addr.port }
        this.server.removeListener("error", reject)
        resolve(this.bound)
      })
    })
  }

  address(): ProxyAddress {
    if (this.bound === null) throw new Error("proxy not listening — call listen() first")
    return this.bound
  }

  decisionLog(): readonly DecisionLogEntry[] {
    return this.log
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private record(host: string, d: EgressDecision): void {
    this.log.push(Object.freeze({ host, decision: d.decision, reason: d.reason, at: this.now() }))
  }

  private decide(host: string): EgressDecision {
    return decideEgress({ host, allowlist: this.config.allowlist, amendments: this.amendments })
  }

  /** Plain-HTTP forward path. Absolute-form URL ⇒ host from the URL. */
  private onRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const target = this.parseHttpTarget(req)
    if (target === null) {
      res.writeHead(400, { "content-type": "text/plain" }).end("malformed proxy request")
      return
    }
    const decision = this.decide(target.host)
    this.record(target.host, decision)
    if (decision.decision === "deny") {
      res.writeHead(403, { "content-type": "text/plain" }).end(`egress denied: ${decision.reason}`)
      return
    }
    this.pipeHttp(req, res, target)
  }

  private parseHttpTarget(req: IncomingMessage): { host: string; port: number; url: URL } | null {
    try {
      // Forward proxies receive absolute-form request URIs.
      const url = new URL(req.url ?? "")
      const port = url.port !== "" ? Number(url.port) : 80
      return { host: url.hostname.toLowerCase(), port, url }
    } catch {
      return null
    }
  }

  private pipeHttp(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    target: { host: string; port: number; url: URL },
  ): void {
    const dialed = this.dial(target.host, target.port)
    const upstream = httpRequest(
      {
        host: dialed.host,
        port: dialed.port,
        method: req.method,
        path: target.url.pathname + target.url.search,
        headers: req.headers,
      },
      (up) => {
        // Post-connect SSRF re-check on the resolved peer (rebinding defense).
        if (this.peerIsBlocked(up.socket)) {
          up.destroy()
          if (!res.headersSent)
            res.writeHead(403).end("egress denied: peer resolved to blocked address")
          return
        }
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on("error", () => {
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "text/plain" }).end("upstream error")
      else res.end()
    })
    req.pipe(upstream)
  }

  /** HTTPS `CONNECT host:443` tunnel path. */
  private onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const { host, port } = splitHostPort(req.url ?? "", 443)
    const decision = this.decide(host)
    this.record(host, decision)
    if (decision.decision === "deny") {
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nProxy-Reason: ${this.sanitize(decision.reason)}\r\n\r\n`,
      )
      return
    }
    this.openTunnel(clientSocket, head, host, port)
  }

  private openTunnel(clientSocket: Socket, head: Buffer, host: string, port: number): void {
    const dialed = this.dial(host, port)
    const upstream = netConnect(dialed.port, dialed.host, () => {
      if (this.peerIsBlocked(upstream)) {
        upstream.destroy()
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nProxy-Reason: peer-blocked\r\n\r\n")
        return
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    const drop = (): void => {
      if (clientSocket.writable) clientSocket.end()
      upstream.destroy()
    }
    upstream.on("error", () => {
      if (!clientSocket.writableEnded) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
    })
    clientSocket.on("error", drop)
  }

  /** Post-connect: is the resolved peer an SSRF-blocked literal address? */
  private peerIsBlocked(sock: Socket): boolean {
    if (!this.peerCheckActive) return false // trusted DI dial (tests)
    const remote = sock.remoteAddress
    if (remote === undefined || remote === "") return false
    if (isIP(remote) === 0) return false
    return classifyHost(remote) !== null
  }

  /** Header values must not contain CR/LF (response-splitting defense). */
  private sanitize(s: string): string {
    return s.replace(/[\r\n]/g, " ")
  }
}
