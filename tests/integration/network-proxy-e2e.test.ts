/**
 * Network-egress proxy — REAL socket e2e (ADR-0428).
 *
 * Hermetic + offline: a local Node http origin on an ephemeral port stands in
 * for "the internet". The proxy binds on an ephemeral port. We drive ACTUAL
 * client sockets (plain-HTTP forward + CONNECT tunnel) through it and assert
 * the allow / deny / amend / SSRF behavior + the per-connection decision log.
 *
 * "e2e로 확실하게 닫아놔" — these tests fail before the slice exists and prove
 * the subprocess egress gap is closed at the socket layer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { type AddressInfo, connect as netConnect } from "node:net"
import {
  type DialTarget,
  LoopbackEgressProxy,
  PROXY_ENV_KEYS,
  withProxyEnv,
} from "@/../src/runtime/network-proxy"

// ── Hermetic upstream origin (the "real internet" for this test) ────────────
let origin: Server
let originPort: number

/** DI dial that maps ANY policy host to the hermetic loopback origin. Keeps the
 *  test offline while still exercising routable NAMES (not loopback literals)
 *  through the real allow/deny policy + real sockets. */
const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })

beforeAll(async () => {
  origin = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("ORIGIN-OK")
  })
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()))
  originPort = (origin.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()))
})

// ── Low-level client helpers (no global proxy agent — we speak proxy proto) ──

/** Send an absolute-form proxy GET and collect the raw response head+body. */
const proxyGet = (
  proxyPort: number,
  absoluteUrl: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      const host = new URL(absoluteUrl).host
      sock.write(`GET ${absoluteUrl} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let buf = ""
    sock.setEncoding("utf8")
    sock.on("data", (c) => {
      buf += c
    })
    sock.on("end", () => {
      const status = Number(buf.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? "0")
      const body = buf.slice(buf.indexOf("\r\n\r\n") + 4)
      resolve({ status, body })
    })
    sock.on("error", reject)
  })

/** Send a CONNECT and return the proxy's status line (does NOT TLS-handshake —
 *  we only verify the tunnel is granted/refused at the proxy layer). */
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

describe("network-proxy e2e — plain HTTP forward", () => {
  test("allowlisted host → 200 tunneled, 'allow' logged", async () => {
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      { dial: toOrigin() },
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyGet(port, "http://allowed.test/")
      expect(res.status).toBe(200)
      expect(res.body).toBe("ORIGIN-OK")
      const log = proxy.decisionLog()
      expect(log.at(-1)?.decision).toBe("allow")
      expect(log.at(-1)?.host).toBe("allowed.test")
    } finally {
      await proxy.close()
    }
  })

  // Off-list host that is NOT a blocked IP, so we exercise the pure
  // allowlist-deny path (a routable-looking name resolving nowhere harmful).
  test("off-list host → 403 + 'deny' entry, no crash", async () => {
    const proxy = new LoopbackEgressProxy({ enabled: true, allowlist: ["api.github.com"] })
    const { port } = await proxy.listen()
    try {
      const res = await proxyGet(port, "http://blocked.example.com/exfil")
      expect(res.status).toBe(403)
      const last = proxy.decisionLog().at(-1)
      expect(last?.decision).toBe("deny")
      expect(last?.host).toBe("blocked.example.com")
    } finally {
      await proxy.close()
    }
  })
})

describe("network-proxy e2e — CONNECT tunnel", () => {
  test("allowlisted authority → 200 Connection Established", async () => {
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      { dial: toOrigin() },
    )
    const { port } = await proxy.listen()
    try {
      const status = await proxyConnect(port, "allowed.test:443")
      expect(status).toBe(200)
      expect(proxy.decisionLog().at(-1)?.decision).toBe("allow")
    } finally {
      await proxy.close()
    }
  })

  test("off-list authority → 403, clean close", async () => {
    const proxy = new LoopbackEgressProxy({ enabled: true, allowlist: ["api.github.com"] })
    const { port } = await proxy.listen()
    try {
      const status = await proxyConnect(port, "blocked.example.com:443")
      expect(status).toBe(403)
      expect(proxy.decisionLog().at(-1)?.decision).toBe("deny")
    } finally {
      await proxy.close()
    }
  })
})

describe("network-proxy e2e — runtime amendment (post-approval)", () => {
  test("denied → amend(host) → allowed + 'amended-allow' logged → revoke → denied", async () => {
    const proxy = new LoopbackEgressProxy({ enabled: true, allowlist: [] }, { dial: toOrigin() })
    const { port } = await proxy.listen()
    try {
      // 1. off-list (empty allowlist) → denied
      const before = await proxyGet(port, "http://amended.example.com/x")
      expect(before.status).toBe(403)
      expect(proxy.decisionLog().at(-1)?.decision).toBe("deny")

      // 2. approve → amend → same host now reaches origin as amended-allow
      proxy.amendments.amend({
        host: "amended.example.com",
        scope: "turn-1",
        reason: "user approved",
      })
      const allowed = await proxyGet(port, "http://amended.example.com/x")
      expect(allowed.status).toBe(200)
      expect(allowed.body).toBe("ORIGIN-OK")
      const amendedEntry = proxy.decisionLog().at(-1)
      expect(amendedEntry?.decision).toBe("amended-allow")
      expect(amendedEntry?.host).toBe("amended.example.com")
      expect(amendedEntry?.reason).toContain("turn-1")

      // 3. revoke the scope → denied again (revocation is fail-closed)
      expect(proxy.amendments.revokeScope("turn-1")).toBe(1)
      const after = await proxyGet(port, "http://amended.example.com/x")
      expect(after.status).toBe(403)
      expect(proxy.decisionLog().at(-1)?.decision).toBe("deny")
    } finally {
      await proxy.close()
    }
  })
})

describe("network-proxy e2e — SSRF guard (blocked even if allowlisted by name)", () => {
  const ssrfTargets = ["169.254.169.254", "127.0.0.1", "10.0.0.5", "192.168.1.1", "::1"]
  for (const host of ssrfTargets) {
    test(`CONNECT ${host}:443 → 403 even when '${host}' is in the allowlist`, async () => {
      const proxy = new LoopbackEgressProxy({ enabled: true, allowlist: [host] })
      const { port } = await proxy.listen()
      try {
        const authority = host.includes(":") ? `[${host}]:443` : `${host}:443`
        const status = await proxyConnect(port, authority)
        expect(status).toBe(403)
        const last = proxy.decisionLog().at(-1)
        expect(last?.decision).toBe("deny")
        expect(last?.reason.toLowerCase()).toContain("ssrf")
      } finally {
        await proxy.close()
      }
    })
  }
})

describe("network-proxy — default-OFF env injection (byte-identical)", () => {
  test("absent proxy address ⇒ env untouched (same reference)", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", FOO: "bar" }
    const out = withProxyEnv(base, {})
    expect(out).toBe(base) // same reference — zero allocation, byte-identical
    for (const k of PROXY_ENV_KEYS) expect(out[k]).toBeUndefined()
  })

  test("present proxy address ⇒ proxy vars injected, base untouched", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" }
    const out = withProxyEnv(base, { address: { host: "127.0.0.1", port: 8123 } })
    expect(out).not.toBe(base)
    expect(base.HTTP_PROXY).toBeUndefined() // base not mutated
    expect(out.HTTP_PROXY).toBe("http://127.0.0.1:8123")
    expect(out.HTTPS_PROXY).toBe("http://127.0.0.1:8123")
    expect(out.NO_PROXY).toContain("127.0.0.1")
  })
})
