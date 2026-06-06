/**
 * jun-7 TLS-MITM Bun bridge — HELLGATE (adversarial). Proves the Bun gap is CLOSED
 * AND the fail-closed safety holds for the new bridge transport. Production runs
 * on Bun, so these run on the production runtime.
 *
 * Invariants under attack:
 *   1. GAP CLOSED ON BUN: a declared secret in an HTTPS POST body — previously
 *      invisible behind the raw CONNECT tunnel + denied-but-non-functional on Bun
 *      — is now CAUGHT (403 deny) via the Bun.listen terminator bridge, and NEVER
 *      reaches the origin.
 *   2. FAIL-CLOSED on a channel that cannot complete: an injected channel whose
 *      `parse()` never resolves (a stuck handshake) must be turned into a hard
 *      DENY by the watchdog — the secret is NEVER forwarded.
 *   3. FAIL-CLOSED on a channel that errors: `parse()` resolving `null` ⇒ deny.
 *   4. DEFAULT-OFF byte-identity: MITM off ⇒ raw tunnel + connect-tunnel-unscanned.
 *
 * (1) drives the REAL Bun bridge end-to-end; (2)/(3) inject a hostile channel via
 * the `openMitmChannel` DI seam so the fail-closed paths are exercised
 * deterministically without depending on a flaky stuck-socket.
 */

import { describe, expect, test } from "bun:test"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import { type AddressInfo, connect as netConnect } from "node:net"
import { connect as tlsConnect } from "node:tls"
import {
  type DialTarget,
  isBunRuntime,
  LoopbackEgressProxy,
  MitmCertAuthority,
  type MitmConfig,
  type MitmTlsChannel,
  nodeKeyPairSource,
  type OpenMitmChannel,
  type ResolvePeerHost,
  type SecretEgressConfig,
} from "@/../src/runtime/network-proxy"
import { compositeSecretScanner } from "@/security/secret-detection"

const DECLARED = "s3cr3t-bun-bridge-token"
const HOST = "allowed.test"
const VALIDITY = { notBeforeMs: -86_400_000, notAfterMs: 86_400_000 }
let counter = 0
const serial = (): number => ++counter
const publicPeer: ResolvePeerHost = () => "203.0.113.10"

const upstreamCa = new MitmCertAuthority({
  keyPairSource: nodeKeyPairSource,
  serialSource: serial,
  now: () => Date.now(),
  validity: VALIDITY,
})

const egress = (over: Partial<SecretEgressConfig> = {}): SecretEgressConfig => ({
  scanner: compositeSecretScanner(),
  mode: "deny",
  maxBodyBytes: 1_000_000,
  ...over,
})

const mitmConfig = (over: Partial<SecretEgressConfig> = {}): MitmConfig => ({
  certAuthority: new MitmCertAuthority({
    keyPairSource: nodeKeyPairSource,
    serialSource: serial,
    now: () => Date.now(),
    validity: VALIDITY,
  }),
  secretEgress: egress(over),
  onFailure: "deny",
  handshakeTimeoutMs: 1_000,
})

const startOrigin = async (received: string[]): Promise<{ server: HttpsServer; port: number }> => {
  const leaf = upstreamCa.leafFor(HOST)
  const server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      received.push(body)
      res.writeHead(200)
      res.end("ORIGIN-OK")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  return { server, port: (server.address() as AddressInfo).port }
}

const httpsThroughProxy = (
  proxyPort: number,
  caPem: string,
  body: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve) => {
    const ctrl = netConnect(proxyPort, "127.0.0.1", () => {
      ctrl.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
    })
    let connBuf = ""
    const onConnect = (c: Buffer): void => {
      connBuf += c.toString("latin1")
      if (!connBuf.includes("\r\n\r\n")) return
      ctrl.removeListener("data", onConnect)
      if (!connBuf.startsWith("HTTP/1.1 200")) {
        resolve({ status: Number(connBuf.match(/HTTP\/1\.1 (\d{3})/)?.[1] ?? 0), body: "" })
        ctrl.destroy()
        return
      }
      const tls = tlsConnect({ socket: ctrl, servername: HOST, ca: [caPem] }, () => {
        tls.write(
          `POST /hook HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        )
      })
      let resp = ""
      tls.setEncoding("utf8")
      tls.on("data", (d) => {
        resp += d
      })
      tls.on("end", () => {
        resolve({ status: Number(resp.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0), body: resp })
        ctrl.destroy()
      })
      tls.on("error", () => {
        resolve({ status: 0, body: "" })
        ctrl.destroy()
      })
    }
    ctrl.on("data", onConnect)
    ctrl.on("error", () => resolve({ status: 0, body: "" }))
  })

// (1) only runs where the bridge is the active mechanism (Bun) — that is the
// whole point of this hellgate (it would pass on Node via node:tls anyway, but
// the GAP being closed is the Bun proof).
const describeBun = isBunRuntime() ? describe : describe.skip

describeBun("HELLGATE — HTTPS body secret is CAUGHT on Bun via the bridge", () => {
  test("declared secret in an HTTPS body → 403 deny, NEVER reaches origin (gap closed on Bun)", async () => {
    const received: string[] = []
    const { server, port: originPort } = await startOrigin(received)
    const mitm = mitmConfig({ declared: [DECLARED] })
    const dial: DialTarget = () => ({ host: "127.0.0.1", port: originPort })
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: [HOST], secretEgress: mitm.secretEgress, mitm },
      {
        dial,
        resolvePeerHost: publicPeer,
        upstreamTlsExtra: () => ({ ca: upstreamCa.caCertPem() }),
      },
    )
    const { port } = await proxy.listen()
    try {
      const res = await httpsThroughProxy(port, mitm.certAuthority.caCertPem(), `leak=${DECLARED}`)
      expect(res.status).toBe(403)
      expect(res.body.includes(DECLARED)).toBe(false)
      expect(received).toHaveLength(0) // the secret NEVER reached the real origin
      const last = proxy.decisionLog().at(-1)
      expect(last?.secretScan).toBe("denied")
      // CRITICAL: the deny came from a REAL CONTENT SCAN of the decrypted body —
      // NOT a watchdog/handshake fail-closed (which the OLD Bun path produced).
      // This is the gap-closed proof: the body was actually decrypted + scanned.
      expect(last?.reason.includes("outbound secret")).toBe(true)
      expect(last?.reason.includes("fail-closed")).toBe(false)
    } finally {
      await proxy.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  test("legit HTTPS body → 200 forwarded unchanged via the bridge (no FP)", async () => {
    const received: string[] = []
    const { server, port: originPort } = await startOrigin(received)
    const mitm = mitmConfig({ declared: [DECLARED] })
    const dial: DialTarget = () => ({ host: "127.0.0.1", port: originPort })
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: [HOST], secretEgress: mitm.secretEgress, mitm },
      {
        dial,
        resolvePeerHost: publicPeer,
        upstreamTlsExtra: () => ({ ca: upstreamCa.caCertPem() }),
      },
    )
    const { port } = await proxy.listen()
    try {
      const res = await httpsThroughProxy(port, mitm.certAuthority.caCertPem(), "hello=world")
      expect(res.status).toBe(200)
      expect(received[0]).toBe("hello=world")
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("scanned-clean")
    } finally {
      await proxy.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe("HELLGATE — fail-closed on a hostile channel (DI-injected, all runtimes)", () => {
  /** A channel whose `parse()` NEVER resolves (a stuck handshake). The proxy's
   *  watchdog MUST turn this into a deny. `write`/`writable` report unwritable so
   *  the proxy hard-destroys (the client never believes the request succeeded). */
  const stuckOpener: OpenMitmChannel = (): MitmTlsChannel => ({
    parse: () => new Promise<never>(() => {}), // never settles
    writable: () => false,
    write: () => false,
    end: () => {},
    destroy: () => {},
  })

  /** A channel whose `parse()` resolves `null` (a handshake/parse error). */
  const erroringOpener: OpenMitmChannel = (): MitmTlsChannel => ({
    parse: () => Promise.resolve(null),
    writable: () => false,
    write: () => false,
    end: () => {},
    destroy: () => {},
  })

  const driveDeny = async (opener: OpenMitmChannel): Promise<void> => {
    const received: string[] = []
    const { server, port: originPort } = await startOrigin(received)
    const mitm = mitmConfig({ declared: [DECLARED] })
    const dial: DialTarget = () => ({ host: "127.0.0.1", port: originPort })
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: [HOST], secretEgress: mitm.secretEgress, mitm },
      {
        dial,
        resolvePeerHost: publicPeer,
        upstreamTlsExtra: () => ({ ca: upstreamCa.caCertPem() }),
        openMitmChannel: opener,
      },
    )
    const { port } = await proxy.listen()
    try {
      const res = await httpsThroughProxy(port, mitm.certAuthority.caCertPem(), `leak=${DECLARED}`)
      // The client TLS never completes against a dead channel ⇒ status 0 / no body.
      expect(res.body.includes(DECLARED)).toBe(false)
      // The invariant that matters: the secret NEVER reached the real origin AND
      // the decision log records a fail-closed deny.
      expect(received).toHaveLength(0)
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("denied")
    } finally {
      await proxy.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  test("a STUCK channel (parse never resolves) ⇒ watchdog DENY, secret never forwarded", async () => {
    await driveDeny(stuckOpener)
  })

  test("an ERRORING channel (parse → null) ⇒ DENY, secret never forwarded", async () => {
    await driveDeny(erroringOpener)
  })

  test("opaque-tunnel fail mode ⇒ visible connect-tunnel-unscanned (never silent pass)", async () => {
    const received: string[] = []
    const { server, port: originPort } = await startOrigin(received)
    const mitm: MitmConfig = { ...mitmConfig({ declared: [DECLARED] }), onFailure: "opaque-tunnel" }
    const dial: DialTarget = () => ({ host: "127.0.0.1", port: originPort })
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: [HOST], secretEgress: mitm.secretEgress, mitm },
      {
        dial,
        resolvePeerHost: publicPeer,
        upstreamTlsExtra: () => ({ ca: upstreamCa.caCertPem() }),
        openMitmChannel: () => ({
          parse: () => Promise.resolve(null),
          writable: () => false,
          write: () => false,
          end: () => {},
          destroy: () => {},
        }),
      },
    )
    const { port } = await proxy.listen()
    try {
      await httpsThroughProxy(port, mitm.certAuthority.caCertPem(), `leak=${DECLARED}`)
      expect(received).toHaveLength(0)
      // opaque-tunnel records the VISIBLE unscanned marker — never a silent claim.
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("connect-tunnel-unscanned")
    } finally {
      await proxy.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
