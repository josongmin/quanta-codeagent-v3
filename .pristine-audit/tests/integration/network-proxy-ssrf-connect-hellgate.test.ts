/**
 * Network-egress proxy — BUG2 PROOF: SSRF CONNECT-path obfuscated-IPv4 +
 * DNS-rebinding peer re-check (ADR-0428, jun-02 SSRF re-audit).
 *
 * BEFORE the fix the CONNECT path classified the RAW `splitHostPort` host, so
 * obfuscated IPv4 literals slipped past `classifyHost` (which recognizes only
 * DOTTED v4 / v6) and the SSRF guard was DEAD on the CONNECT path; the metadata
 * special-case was exact-string `=== "169.254.169.254"`, evaded by the decimal
 * form `2852039166`. The fix normalizes the CONNECT authority through the URL
 * parser (mirroring the HTTP path) BEFORE classification and makes the metadata
 * detection structural.
 *
 * Also proves the post-connect peer re-check (DNS-rebinding defense) FIRES even
 * with an injected `dial` — the previous code disabled it whenever a DI dial was
 * present, silently turning the rebinding defense OFF.
 *
 * Deterministic, real sockets on ephemeral ports, hermetic local upstream, no
 * heuristics — assertions are the SSRF classification reason + status only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { type AddressInfo, connect as netConnect } from "node:net"
import {
  type DialTarget,
  LoopbackEgressProxy,
  type ResolvePeerHost,
} from "@/../src/runtime/network-proxy"

let origin: Server
let originPort: number
const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })

beforeAll(async () => {
  origin = createServer((_req, res) => res.end("ORIGIN-OK"))
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()))
  originPort = (origin.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()))
})

/** Send a CONNECT and return the proxy's status line code. */
const proxyConnect = (proxyPort: number, authority: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    let buf = ""
    sock.setEncoding("utf8")
    sock.on("data", (c) => {
      buf += c
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/)
      if (m !== null) {
        sock.destroy()
        resolve(Number(m[1]))
      }
    })
    sock.on("error", reject)
    sock.on("close", () => {
      if (buf === "") reject(new Error("connection closed with no response"))
    })
  })

describe("network-proxy BUG2 — obfuscated IPv4 blocked as SSRF on the CONNECT path", () => {
  // Each obfuscated literal canonicalizes to an internal address; the SSRF guard
  // must fire even though the literal is on the allowlist BY (obfuscated) NAME.
  const cases: ReadonlyArray<{ readonly authority: string; readonly canonical: string }> = [
    { authority: "2130706433:443", canonical: "127.0.0.1 (decimal loopback)" },
    { authority: "0x7f000001:443", canonical: "127.0.0.1 (hex loopback)" },
    { authority: "127.1:443", canonical: "127.0.0.1 (shorthand loopback)" },
    { authority: "2852039166:443", canonical: "169.254.169.254 (decimal metadata)" },
  ]
  for (const { authority, canonical } of cases) {
    test(`CONNECT ${authority} ⇒ 403 SSRF (${canonical}), even though allowlisted`, async () => {
      // Allowlist the RAW obfuscated host so the ONLY thing that can deny it is
      // the SSRF classification (not a deny-by-empty-allowlist).
      const rawHost = authority.split(":")[0] ?? authority
      const proxy = new LoopbackEgressProxy({ enabled: true, allowlist: [rawHost] })
      const { port } = await proxy.listen()
      try {
        const status = await proxyConnect(port, authority)
        expect(status).toBe(403)
        const last = proxy.decisionLog().at(-1)
        expect(last?.decision).toBe("deny")
        // Assert the reason is the SSRF CLASSIFICATION (not generic deny).
        expect(last?.reason.toLowerCase()).toContain("ssrf")
      } finally {
        await proxy.close()
      }
    })
  }

  test("decimal-metadata 2852039166 yields the dedicated metadata reason", async () => {
    const proxy = new LoopbackEgressProxy({ enabled: true, allowlist: ["2852039166"] })
    const { port } = await proxy.listen()
    try {
      const status = await proxyConnect(port, "2852039166:443")
      expect(status).toBe(403)
      const reason = (proxy.decisionLog().at(-1)?.reason ?? "").toLowerCase()
      // Structural metadata detection — canonicalized to 169.254.169.254.
      expect(reason).toContain("metadata")
      expect(reason).toContain("169.254.169.254")
    } finally {
      await proxy.close()
    }
  })
})

describe("network-proxy BUG2 — DNS-rebinding peer re-check fires WITH an injected dial", () => {
  test("name allowed, dial → hermetic origin, peer resolves internal ⇒ tunnel dropped", async () => {
    // The NAME is allowlisted and SSRF-clear, so the decision layer ALLOWS it.
    // The dial maps to the hermetic loopback origin (so the upstream connects),
    // but the peer-classification resolver reports an INTERNAL literal — the
    // rebinding defense must still drop the tunnel. Previously an injected dial
    // disabled this check entirely.
    const internalPeer: ResolvePeerHost = () => "169.254.169.254"
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["rebind.example.com"] },
      { dial: toOrigin(), resolvePeerHost: internalPeer },
    )
    const { port } = await proxy.listen()
    try {
      const status = await proxyConnect(port, "rebind.example.com:443")
      // Decision allowed the name, but the peer re-check refused the tunnel.
      expect(status).toBe(403)
      // The decision log records the NAME allow (the block is post-connect).
      expect(proxy.decisionLog().at(-1)?.decision).toBe("allow")
    } finally {
      await proxy.close()
    }
  })

  test("public peer ⇒ tunnel established (re-check passes, control case)", async () => {
    const publicPeer: ResolvePeerHost = () => "203.0.113.10"
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["ok.example.com"] },
      { dial: toOrigin(), resolvePeerHost: publicPeer },
    )
    const { port } = await proxy.listen()
    try {
      const status = await proxyConnect(port, "ok.example.com:443")
      expect(status).toBe(200)
    } finally {
      await proxy.close()
    }
  })
})
