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

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http"
import { request as httpsRequestOverTls } from "node:https"
import { isIP, connect as netConnect, type Socket } from "node:net"
import { createSecureContext, TLSSocket, type TLSSocket as TLSSocketType } from "node:tls"
import { classifyHost } from "@/shared/net/ssrf"
import { NetworkPolicyAmendment } from "./amendment"
import { decideEgress, type EgressDecision } from "./decision"
import type { MitmConfig } from "./mitm"
import type { NetworkProxyPort } from "./port"
import { decideEgressScan, type SecretEgressConfig } from "./secret-egress"
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

/**
 * Peer-classification resolver (DI seam, jun-02 SSRF re-audit). Given the
 * connected upstream socket, returns the address the post-connect SSRF re-check
 * should CLASSIFY (DNS-rebinding defense). Production omits it ⇒ the resolver
 * classifies `sock.remoteAddress` (the address the OS actually connected to).
 *
 * This is INTENTIONALLY decoupled from {@link DialTarget}: a hermetic test maps
 * routable NAMES to a loopback origin via `dial`, but the peer it wants the
 * security guard to JUDGE is the host the name would resolve to in production —
 * NOT the loopback redirect. Previously the peer re-check was DISABLED whenever
 * a `dial` DI was present (`peerCheckActive = dial === undefined`), which meant
 * an injected dial silently turned the rebinding defense OFF. Now the re-check
 * ALWAYS runs; tests that need a hermetic dial supply `resolvePeerHost` so the
 * classification still fires on the address they choose (a public hermetic peer
 * for allow-path tests; an internal literal for the rebinding-block proof).
 */
export type ResolvePeerHost = (sock: Socket) => string | undefined

/** A readable byte stream just wide enough for {@link readCappedBody} (both
 *  `http.IncomingMessage` and a TLS socket satisfy it). */
interface ByteReadable {
  on(event: "data", cb: (chunk: Buffer) => void): unknown
  on(event: "end", cb: () => void): unknown
  on(event: "error", cb: (err: unknown) => void): unknown
}

/** The outcome of a STREAMING-capped body read: the buffered bytes (capped) +
 *  whether the stream went over the cap (the overflow is NOT retained). */
export interface CappedBody {
  readonly body: Buffer
  readonly overCap: boolean
}

/**
 * Read a request body with a STREAMING byte cap. Once the accumulated size
 * exceeds `cap`, we STOP accumulating (releasing what we held) and flag
 * `overCap` — so a hostile huge body can NEVER be fully buffered in memory
 * (the DoS guard). Used by BOTH the plaintext path and the TLS-MITM parse path
 * so the cap discipline is defined ONCE (the MITM path previously buffered the
 * whole body before consulting the cap — a memory-DoS the plaintext path never
 * had). Resolves on `end` OR `error` (a truncated read is still capped). Pure
 * aside from the stream it drains; never throws.
 */
export const readCappedBody = (stream: ByteReadable, cap: number): Promise<CappedBody> =>
  new Promise((resolve) => {
    let chunks: Buffer[] = []
    let size = 0
    let overCap = false
    const finish = (): void =>
      resolve({ body: overCap ? Buffer.alloc(0) : Buffer.concat(chunks), overCap })
    stream.on("data", (c: Buffer) => {
      if (overCap) return
      size += c.length
      if (size > cap) {
        overCap = true
        chunks = [] // release what we held; the overflow is never scanned/forwarded
        return
      }
      chunks.push(c)
    })
    stream.on("end", finish)
    stream.on("error", finish)
  })

/** A single decrypted HTTP request parsed off a terminated TLS-MITM socket. */
interface ParsedTlsRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  /** Header values concatenated for the secret scan (names are not secrets). */
  readonly headerText: string
  /** The buffered request body, CAPPED at the scan budget (a body past the cap is
   *  truncated here — never fully held in memory — and {@link bodyOverCap} set so
   *  the caller forwards UNSCANNED rather than scanning a partial body). */
  readonly body: Buffer
  /** True IFF the decrypted body exceeded the scan cap (so it was NOT fully
   *  buffered). The caller forwards it unscanned with a `body-cap-unscanned`
   *  marker — identical disposition to the plaintext path's streaming cap. */
  readonly bodyOverCap: boolean
}

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

/**
 * R-audit (jun-02) SSRF CONNECT-path fix: normalize a raw authority host through
 * the WHATWG URL parser BEFORE policy classification — EXACTLY as the plain-HTTP
 * path already does (`new URL(req.url).hostname`). Without this the CONNECT path
 * decided on the RAW `splitHostPort` host, so obfuscated IPv4 literals
 * (`2130706433` / `0x7f000001` / `127.1` / decimal-metadata `2852039166`) slipped
 * past `classifyHost` (which only recognizes DOTTED v4 / v6) and the SSRF guard
 * was dead on the CONNECT path. `new URL("http://"+host).hostname` canonicalizes
 * every such form to its dotted equivalent (2130706433 → 127.0.0.1,
 * 2852039166 → 169.254.169.254), so the SAME `decideEgress` SSRF guard fires.
 *
 * Returns the canonical bare hostname (brackets stripped by `bareHost` on the
 * way in; the URL parser re-adds them for IPv6 so we strip again). On a parse
 * failure we return the lowercased bare host unchanged — `decideEgress` then
 * fails closed (an unrecognized form is not on any allowlist).
 */
const normalizeHost = (rawBareHost: string): string => {
  // `bareHost` already stripped IPv6 brackets, so re-bracket a v6 literal for
  // the URL parser (which requires brackets), else parse the bare form directly.
  const authority = rawBareHost.includes(":") ? `[${rawBareHost}]` : rawBareHost
  try {
    const h = new URL(`http://${authority}`).hostname
    // IPv6 hostnames come back bracketed from the URL parser; keep the bare form
    // (classifyHost strips brackets defensively, but the dial wants bare too).
    return (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h).toLowerCase()
  } catch {
    return rawBareHost.toLowerCase()
  }
}

/** Parse `host:port` into a dial target, NORMALIZING the host (URL parser) so the
 *  CONNECT path classifies obfuscated IPv4 the SAME way the HTTP path does. HTTP
 *  default 80, HTTPS CONNECT 443. */
const splitHostPort = (authority: string, defaultPort: number): { host: string; port: number } => {
  const host = normalizeHost(bareHost(authority))
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
  /** jun-02 SSRF re-audit: the peer SSRF re-check is now ALWAYS active (a DI
   *  dial no longer disables it). `resolvePeerHost` picks WHICH address gets
   *  classified — defaults to the real `sock.remoteAddress` in production. */
  private readonly resolvePeerHost: ResolvePeerHost

  /**
   * jun-7 TLS-MITM (test-only DI seam): EXTRA upstream-TLS options merged into the
   * proxy's OWN upstream connection. Production returns `{}` ⇒ the default trust
   * store validates the real server cert (`rejectUnauthorized: true`). A hermetic
   * e2e injects `{ ca: <test-CA> }` so its self-signed origin validates — WITHOUT
   * ever lowering `rejectUnauthorized` (the test that proves "bad upstream cert ⇒
   * fail" injects a CA that does NOT cover the origin's cert). This NEVER disables
   * verification; it only supplies an additional trust root for a hermetic origin.
   */
  private readonly upstreamTlsExtra: () => Record<string, unknown>

  constructor(
    private readonly config: NetworkProxyConfig,
    deps: {
      now?: () => number
      amendments?: NetworkPolicyAmendment
      dial?: DialTarget
      resolvePeerHost?: ResolvePeerHost
      upstreamTlsExtra?: () => Record<string, unknown>
    } = {},
  ) {
    this.now = deps.now ?? Date.now
    this.amendments = deps.amendments ?? new NetworkPolicyAmendment(this.now)
    this.dial = deps.dial ?? IDENTITY_DIAL
    this.resolvePeerHost = deps.resolvePeerHost ?? ((s) => s.remoteAddress)
    this.upstreamTlsExtra = deps.upstreamTlsExtra ?? (() => ({}))
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

  private record(
    host: string,
    d: EgressDecision,
    secretScan?: DecisionLogEntry["secretScan"],
  ): void {
    this.log.push(
      Object.freeze({
        host,
        decision: d.decision,
        reason: d.reason,
        at: this.now(),
        ...(secretScan !== undefined ? { secretScan } : {}),
      }),
    )
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
    // jun-6 exfil-rail (B): host is allowed — when secret-egress is wired, scan
    // the outbound BODY + HEADERS (plaintext-HTTP only; see onConnect for the
    // honest HTTPS gap) before forwarding. Absent ⇒ host-only, byte-identical.
    if (this.config.secretEgress !== undefined) {
      void this.scanAndPipeHttp(req, res, target, this.config.secretEgress)
      return
    }
    this.pipeHttp(req, res, target)
  }

  /**
   * jun-6 exfil-rail (B) — buffer the outbound body up to the configured cap,
   * scan body + header values for a leaving secret, then deny / redact / forward
   * (RFC §4.4). A body past `maxBodyBytes` is forwarded UNSCANNED with a logged
   * `body-cap-unscanned` marker (DoS guard — never blocked-by-truncation).
   * PLAINTEXT-HTTP ONLY — the HTTPS CONNECT tunnel is opaque (see onConnect).
   */
  private async scanAndPipeHttp(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    target: { host: string; port: number; url: URL },
    cfg: SecretEgressConfig,
  ): Promise<void> {
    const buffered = await this.bufferBody(req, cfg.maxBodyBytes)
    if (buffered === null) {
      // Over the cap — forward UNSCANNED (never blocked-by-truncation), but make
      // the unscanned disposition VISIBLE in the log.
      this.record(
        target.host,
        { decision: "allow", reason: "secret-egress: body over cap" },
        "body-cap-unscanned",
      )
      this.pipeHttp(req, res, target)
      return
    }

    const headerText = this.headerScanText(req)
    const disposition = await decideEgressScan(buffered, headerText, cfg)

    if (disposition.kind === "deny") {
      // Deny: either the operator chose deny, OR a scanner-only finding (no exact
      // declared span) means we cannot SAFELY redact in place — failing closed
      // (deny) beats forwarding an under-redacted payload.
      this.record(target.host, { decision: "deny", reason: disposition.reason }, "denied")
      res.writeHead(403, { "content-type": "text/plain" }).end(disposition.reason)
      return
    }
    if (disposition.kind === "redact") {
      // Redact: mask the declared spans in the body, drop the offending headers,
      // forward the rest.
      this.record(target.host, { decision: "allow", reason: disposition.reason }, "redacted")
      this.pipeBufferedHttp(
        req,
        res,
        target,
        disposition.redactedBody,
        disposition.dropHeaderValues,
      )
      return
    }

    this.record(
      target.host,
      { decision: "allow", reason: "secret-egress: scanned clean" },
      "scanned-clean",
    )
    this.pipeBufferedHttp(req, res, target, buffered, [])
  }

  /** Buffer the request body, returning `null` if it exceeds `cap` bytes (so the
   *  caller forwards it unscanned rather than blocking-by-truncation). */
  private async bufferBody(req: IncomingMessage, cap: number): Promise<string | null> {
    const { body, overCap } = await readCappedBody(req, cap)
    return overCap ? null : body.toString("utf8")
  }

  /** Concatenate header values into a single scannable text blob (header NAMES
   *  are not secrets; only values are scanned). */
  private headerScanText(req: IncomingMessage): string {
    return Object.values(req.headers)
      .map((v) => (Array.isArray(v) ? v.join(" ") : (v ?? "")))
      .join("\n")
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

  /**
   * jun-6 exfil-rail (B) — forward an already-BUFFERED (possibly redacted) body
   * instead of streaming the live request, dropping the named offending headers
   * (a header value that carried a redacted declared secret is removed entirely
   * rather than forwarded). Used by the secret-egress scan path. Functionally
   * mirrors {@link pipeHttp} but writes a concrete body + fixes content-length.
   */
  private pipeBufferedHttp(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    target: { host: string; port: number; url: URL },
    body: string,
    dropHeaderValues: readonly string[],
  ): void {
    const dialed = this.dial(target.host, target.port)
    const bodyBuf = Buffer.from(body, "utf8")
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      // Drop a header whose value carried a redacted declared secret.
      const flat = Array.isArray(value) ? value.join(" ") : value
      if (dropHeaderValues.some((v) => v.length > 0 && flat.includes(v))) continue
      headers[name] = value
    }
    // The buffered body's length may differ from the original (redaction), so
    // overwrite content-length and never forward a stale transfer-encoding.
    delete headers["transfer-encoding"]
    if (req.method !== "GET" && req.method !== "HEAD")
      headers["content-length"] = String(bodyBuf.length)
    const upstream = httpRequest(
      {
        host: dialed.host,
        port: dialed.port,
        method: req.method,
        path: target.url.pathname + target.url.search,
        headers,
      },
      (up) => {
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
    if (bodyBuf.length > 0) upstream.write(bodyBuf)
    upstream.end()
  }

  /** HTTPS `CONNECT host:443` tunnel path. */
  private onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    const { host, port } = splitHostPort(req.url ?? "", 443)
    const decision = this.decide(host)
    // jun-6 exfil-rail (B) — HONEST HTTPS GAP. When secret-egress is wired we
    // CANNOT scan a CONNECT tunnel's body/headers (raw TLS bytes, opaque to the
    // proxy — full coverage needs MITM, a deferred Phase-2 RFC). Record a
    // dedicated `connect-tunnel-unscanned` marker on an ALLOWED tunnel so the
    // gap is VISIBLE in the decision log, never a silent claim of coverage.
    if (decision.decision === "deny") {
      this.record(host, decision)
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nProxy-Reason: ${this.sanitize(decision.reason)}\r\n\r\n`,
      )
      return
    }

    // jun-7 TLS-MITM (Phase-2): when MITM is wired (operator-opt-in ONLY) we
    // TERMINATE this allowed CONNECT, scan the decrypted request with the SAME
    // secret-egress core as the plaintext path, then re-originate upstream TLS
    // (validating the REAL server cert). The decision-log marker is no longer
    // `connect-tunnel-unscanned` — the body WAS scanned.
    if (this.config.mitm !== undefined) {
      // Tell the client the tunnel is up, then hand the SAME socket to the local
      // TLS terminator (the client now begins its TLS ClientHello to us).
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      void this.mitmTerminate(clientSocket, host, port, this.config.mitm, decision)
      return
    }

    // jun-6 exfil-rail (B) — HONEST HTTPS GAP (MITM off). When secret-egress is
    // wired we CANNOT scan a raw CONNECT tunnel's body/headers (opaque TLS
    // bytes). Record a dedicated `connect-tunnel-unscanned` marker on an ALLOWED
    // tunnel so the gap is VISIBLE, never a silent claim of coverage.
    const secretScan: DecisionLogEntry["secretScan"] =
      this.config.secretEgress !== undefined ? "connect-tunnel-unscanned" : undefined
    this.record(host, decision, secretScan)
    this.openTunnel(clientSocket, head, host, port)
  }

  /**
   * jun-7 TLS-MITM — terminate TLS for an ALLOWED CONNECT, scan the decrypted
   * request, re-originate upstream. Fail-closed per `mitm.onFailure`.
   *
   * Flow:
   *   1. Wrap `clientSocket` in a SERVER-side TLSSocket presenting the leaf cert
   *      minted for `host` (signed by the ephemeral CA the agent's client
   *      trusts). The handshake completes against OUR CA only.
   *   2. Parse the decrypted bytes as ONE HTTP request (a one-shot http.Server on
   *      top of the TLSSocket). Buffer the body up to the cap.
   *   3. Run the SHARED `decideEgressScan` (deny / redact / clean).
   *   4. On deny ⇒ 403 over the terminated TLS + close (fail closed). Otherwise
   *      open an OWN upstream TLS connection to the real host, VALIDATING the real
   *      server cert (default trust store — NOT our MITM CA), forward the
   *      (possibly redacted) request, pipe the response back.
   *
   * Any handshake / mint / scan error ⇒ {@link mitmFailClosed}.
   */
  private async mitmTerminate(
    clientSocket: Socket,
    host: string,
    port: number,
    mitm: MitmConfig,
    decision: EgressDecision,
  ): Promise<void> {
    let leaf: { certPem: string; keyPem: string }
    try {
      leaf = mitm.certAuthority.leafFor(host)
    } catch {
      this.mitmFailClosed(clientSocket, host, mitm, decision, "leaf-mint-failed")
      return
    }

    // Server-side TLS on the client socket (we present the leaf).
    let tlsClient: TLSSocketType
    try {
      tlsClient = new TLSSocket(clientSocket, {
        isServer: true,
        secureContext: createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }),
      })
    } catch {
      this.mitmFailClosed(clientSocket, host, mitm, decision, "tls-context-failed")
      return
    }

    // A handshake failure (e.g. a cert-pinning client that refuses our leaf) ⇒
    // fail closed. We never silently pass it unscanned.
    let handshakeFailed = false
    const failHandshake = (cause: string): void => {
      if (handshakeFailed) return
      handshakeFailed = true
      this.mitmFailClosed(clientSocket, host, mitm, decision, cause, tlsClient)
    }
    tlsClient.on("error", () => failHandshake("client-handshake-error"))

    // FAIL-CLOSED WATCHDOG: if the decrypted request does not parse within the
    // budget (a stuck/incompatible handshake — e.g. a runtime that cannot drive
    // server-side TLS on a CONNECT-upgraded socket), we DENY rather than hang.
    // This guarantees a stuck MITM never silently lets unscanned bytes leave.
    const timer = setTimeout(() => failHandshake("handshake-timeout"), mitm.handshakeTimeoutMs)
    if (typeof timer.unref === "function") timer.unref()

    // Parse exactly one decrypted HTTP request off the TLS socket. The body is
    // buffered with a STREAMING cap (`maxBodyBytes`) so a huge decrypted HTTPS
    // body can NEVER be fully held in memory (DoS parity with the plaintext
    // `bufferBody` path — see the over-cap handling below).
    const cfg = mitm.secretEgress
    const parsed = await this.parseTlsRequest(tlsClient, cfg.maxBodyBytes)
    clearTimeout(timer)
    if (handshakeFailed) return
    if (parsed === null) {
      this.mitmFailClosed(clientSocket, host, mitm, decision, "request-parse-failed")
      return
    }

    if (parsed.bodyOverCap) {
      // Over the cap — the body was NOT fully buffered (streaming cap, so a huge
      // decrypted body can never OOM the proxy). Unlike the plaintext path (which
      // re-streams the untouched original `req`), the MITM path has already
      // consumed the TLS bytes into the parser, so we CANNOT losslessly forward
      // the original body — `parsed.body` is truncated. Scanning a partial body
      // is unsafe (the secret could sit past the cap) AND forwarding a truncated
      // body would corrupt the request. So FAIL CLOSED per `onFailure` (deny /
      // opaque-tunnel): if we cannot scan it AND cannot forward it intact, it does
      // not leave. The gap stays VISIBLE in the log.
      this.mitmFailClosed(clientSocket, host, mitm, decision, "body-over-cap", tlsClient)
      return
    }
    const buffered = parsed.body.toString("utf8")

    let disposition: Awaited<ReturnType<typeof decideEgressScan>>
    try {
      disposition = await decideEgressScan(buffered, parsed.headerText, cfg)
    } catch {
      this.mitmFailClosed(clientSocket, host, mitm, decision, "scan-error", tlsClient)
      return
    }

    if (disposition.kind === "deny") {
      // Fail closed at the scan: a secret is leaving. 403 over the terminated TLS.
      this.record(host, { decision: "deny", reason: disposition.reason }, "denied")
      this.writeTlsHttp(tlsClient, 403, disposition.reason)
      return
    }
    if (disposition.kind === "redact") {
      this.record(host, { decision: "allow", reason: disposition.reason }, "redacted")
      this.mitmForwardUpstream(
        tlsClient,
        host,
        port,
        parsed,
        Buffer.from(disposition.redactedBody, "utf8"),
        disposition.dropHeaderValues,
      )
      return
    }
    this.record(
      host,
      { decision: "allow", reason: "secret-egress: scanned clean (mitm)" },
      "scanned-clean",
    )
    this.mitmForwardUpstream(tlsClient, host, port, parsed, parsed.body, [])
  }

  /**
   * Re-originate upstream over OUR OWN TLS connection to the real host,
   * VALIDATING the real server cert (`rejectUnauthorized: true`, default trust
   * store — NOT our MITM CA). The MITM inserts a scan point; it does NOT weaken
   * upstream verification. A bad/forged upstream cert ⇒ the upstream socket
   * errors ⇒ we 502 the client (we never blindly accept a server we could not
   * authenticate).
   */
  private mitmForwardUpstream(
    tlsClient: TLSSocketType,
    host: string,
    port: number,
    parsed: ParsedTlsRequest,
    body: Buffer,
    dropHeaderValues: readonly string[],
  ): void {
    const dialed = this.dial(host, port)
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(parsed.headers)) {
      if (value === undefined) continue
      const flat = Array.isArray(value) ? value.join(" ") : value
      if (dropHeaderValues.some((v) => v.length > 0 && flat.includes(v))) continue
      headers[name] = value
    }
    delete headers["transfer-encoding"]
    if (parsed.method !== "GET" && parsed.method !== "HEAD")
      headers["content-length"] = String(body.length)

    const upstream = httpsRequestOverTls(
      {
        // Test-only EXTRA trust root for a hermetic origin (spread FIRST so the
        // security-critical fields below ALWAYS win — `rejectUnauthorized` can
        // never be flipped off by the extra). Production returns `{}`.
        ...this.upstreamTlsExtra(),
        host: dialed.host,
        port: dialed.port,
        // The TLS layer must validate the REAL host's cert: SNI + verify against
        // the default trust store. NEVER our MITM CA, NEVER rejectUnauthorized:false.
        servername: host,
        rejectUnauthorized: true,
        method: parsed.method,
        path: parsed.path,
        headers,
      },
      (up) => {
        if (this.peerIsBlocked(up.socket)) {
          up.destroy()
          this.writeTlsHttp(tlsClient, 403, "egress denied: peer resolved to blocked address")
          return
        }
        // Re-encrypt the upstream response back to the client over OUR TLS.
        const statusLine = `HTTP/1.1 ${up.statusCode ?? 502} ${up.statusMessage ?? ""}\r\n`
        const headerLines = Object.entries(up.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`)
          .join("")
        if (tlsClient.writable) tlsClient.write(statusLine + headerLines + "\r\n")
        up.on("data", (c: Buffer) => {
          if (tlsClient.writable) tlsClient.write(c)
        })
        up.on("end", () => {
          if (tlsClient.writable) tlsClient.end()
        })
      },
    )
    upstream.on("error", () => {
      // Upstream cert rejection / dial failure / reset ⇒ 502, never a blind pass.
      this.writeTlsHttp(tlsClient, 502, "upstream TLS error (cert not validated or unreachable)")
    })
    if (body.length > 0 && parsed.method !== "GET" && parsed.method !== "HEAD") upstream.write(body)
    upstream.end()
  }

  /**
   * Fail-closed handler for a TLS-MITM termination error. Per
   * `mitm.onFailure`:
   *   - `"deny"` ⇒ a hard 403/close: if we cannot scan it, it does not leave.
   *   - `"opaque-tunnel"` ⇒ fall back to the raw tunnel (availability for
   *     cert-pinned hosts) + a VISIBLE `connect-tunnel-unscanned` marker so the
   *     un-scanned disposition is never silent.
   * NEVER silently forwards unscanned without a marker.
   */
  private mitmFailClosed(
    clientSocket: Socket,
    host: string,
    mitm: MitmConfig,
    decision: EgressDecision,
    cause: string,
    tlsClient?: TLSSocketType,
  ): void {
    if (mitm.onFailure === "opaque-tunnel") {
      // We already wrote `200 Connection Established`; if TLS hasn't begun we
      // cannot cleanly re-tunnel the same socket, so this fallback is best-effort
      // ONLY when termination never consumed bytes. Record the visible gap.
      this.record(host, decision, "connect-tunnel-unscanned")
      if (tlsClient !== undefined && !tlsClient.destroyed) tlsClient.destroy()
      if (!clientSocket.destroyed) clientSocket.destroy()
      return
    }
    // Default: deny — hard close, scanned-as-denied so the gap is never silent.
    // The deny is recorded REGARDLESS of whether we can write a clean 403 (a
    // stuck/unsupported handshake may leave the TLS socket un-writable). The
    // invariant that matters: nothing leaves unscanned + the log says `denied`.
    this.record(host, { decision: "deny", reason: `mitm fail-closed: ${cause}` }, "denied")
    const wrote =
      tlsClient?.writable === true &&
      this.writeTlsHttp(tlsClient, 403, `egress denied: mitm fail-closed (${cause})`)
    if (!wrote) {
      // Could not deliver a clean 403 — hard-destroy so the client errors out
      // promptly (it must NOT believe the request was forwarded).
      if (tlsClient !== undefined && !tlsClient.destroyed) tlsClient.destroy()
      if (!clientSocket.destroyed) clientSocket.destroy()
    }
  }

  /** Write a minimal HTTP response over the terminated TLS socket + close.
   *  Returns `true` IFF the write was delivered; on ANY error (e.g. a runtime
   *  that left the TLS socket un-handshaked) returns `false` so the caller
   *  hard-destroys instead. NO-THROW. */
  private writeTlsHttp(tlsClient: TLSSocketType, status: number, body: string): boolean {
    if (!tlsClient.writable) {
      if (!tlsClient.destroyed) tlsClient.destroy()
      return false
    }
    const safe = this.sanitize(body)
    try {
      tlsClient.end(
        `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 502 ? "Bad Gateway" : "OK"}\r\n` +
          `content-type: text/plain\r\ncontent-length: ${Buffer.byteLength(safe)}\r\n\r\n${safe}`,
      )
      return true
    } catch {
      if (!tlsClient.destroyed) tlsClient.destroy()
      return false
    }
  }

  /**
   * Parse exactly ONE decrypted HTTP request off the terminated TLS socket by
   * running a one-shot in-process `http.Server` over it. Returns the method /
   * path / headers / buffered body, or `null` on a parse error / timeout-less
   * close. The body is buffered fully (the cap is applied by the caller).
   */
  private parseTlsRequest(
    tlsClient: TLSSocketType,
    maxBodyBytes: number,
  ): Promise<ParsedTlsRequest | null> {
    return new Promise((resolve) => {
      let settled = false
      const done = (v: ParsedTlsRequest | null): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      const innerServer = createServer((req, _res) => {
        // STREAMING cap (DoS parity with `bufferBody` — SAME `readCappedBody`):
        // a huge decrypted HTTPS body is never fully held in memory. Over the cap
        // ⇒ `bodyOverCap` set + the body released; the caller fails closed (cannot
        // scan a partial body, cannot forward a truncated one over the already-
        // consumed TLS socket).
        void readCappedBody(req, maxBodyBytes).then(({ body, overCap }) => {
          const url = new URL(req.url ?? "/", "http://placeholder")
          done({
            method: req.method ?? "GET",
            path: url.pathname + url.search,
            headers: req.headers,
            headerText: this.headerScanText(req),
            body,
            bodyOverCap: overCap,
          })
        })
        req.on("error", () => done(null))
      })
      innerServer.on("clientError", () => done(null))
      // Feed the already-accepted TLS socket into the HTTP parser.
      innerServer.emit("connection", tlsClient)
      tlsClient.on("error", () => done(null))
      tlsClient.on("close", () => done(null))
    })
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

  /** Post-connect: is the resolved peer an SSRF-blocked literal address?
   *  ALWAYS runs (jun-02 re-audit) — `resolvePeerHost` selects the address to
   *  classify (real `sock.remoteAddress` in production; a test-chosen peer under
   *  a hermetic dial). A non-IP / empty resolution is treated as "not a literal"
   *  ⇒ not blocked here (a DNS name was already allowed by the decision layer). */
  private peerIsBlocked(sock: Socket): boolean {
    const remote = this.resolvePeerHost(sock)
    if (remote === undefined || remote === "") return false
    if (isIP(remote) === 0) return false
    return classifyHost(remote) !== null
  }

  /** Header values must not contain CR/LF (response-splitting defense). */
  private sanitize(s: string): string {
    return s.replace(/[\r\n]/g, " ")
  }
}
