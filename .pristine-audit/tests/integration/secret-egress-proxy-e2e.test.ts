/**
 * jun-6 exfil-rail (B) — secret-aware egress REAL-socket e2e.
 *
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.4 / §6 (B) / §7 (B).
 *
 * Hermetic + offline: a local Node http origin stands in for "the internet".
 * We drive ACTUAL client sockets (plaintext-HTTP POST + CONNECT) through the
 * LoopbackEgressProxy and assert the secret-egress disposition:
 *  - a secret in an outbound PLAINTEXT-HTTP body → 403 (deny) / masked (redact).
 *  - a secret in a request HEADER value → denied.
 *  - a legit body → forwarded unchanged (no FP).
 *  - an HTTPS CONNECT tunnel → logged `connect-tunnel-unscanned` (the HONEST
 *    HTTPS gap is VISIBLE, not a silent claim of coverage).
 *  - a body over the byte cap → forwarded UNSCANNED (`body-cap-unscanned`),
 *    never blocked-by-truncation.
 *  - `secretEgress` absent ⇒ host-only decision, byte-identical (no secretScan).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { type AddressInfo, connect as netConnect } from "node:net"
import {
  type DialTarget,
  LoopbackEgressProxy,
  type ResolvePeerHost,
  type SecretEgressConfig,
} from "@/../src/runtime/network-proxy"
import { compositeSecretScanner } from "@/security/secret-detection"

const DECLARED = "s3cr3t-deploy-token-do-not-leak"
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"

let origin: Server
let originPort: number
/** Bodies the hermetic origin actually received (to assert redaction reached it). */
let received: string[] = []

const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })
const publicPeer: ResolvePeerHost = () => "203.0.113.10"
const hermetic = (): { dial: DialTarget; resolvePeerHost: ResolvePeerHost } => ({
  dial: toOrigin(),
  resolvePeerHost: publicPeer,
})

const egress = (over: Partial<SecretEgressConfig> = {}): SecretEgressConfig => ({
  scanner: compositeSecretScanner(),
  mode: "deny",
  maxBodyBytes: 1_000_000,
  ...over,
})

beforeAll(async () => {
  origin = createServer((req: IncomingMessage, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      received.push(body)
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ORIGIN-OK")
    })
  })
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()))
  originPort = (origin.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()))
})

/** Send an absolute-form proxy POST with a body + optional extra header. */
const proxyPost = (
  proxyPort: number,
  absoluteUrl: string,
  body: string,
  extraHeader?: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      const host = new URL(absoluteUrl).host
      const len = Buffer.byteLength(body)
      const xh = extraHeader ? `${extraHeader}\r\n` : ""
      sock.write(
        `POST ${absoluteUrl} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: ${len}\r\n${xh}Connection: close\r\n\r\n${body}`,
      )
    })
    let buf = ""
    sock.setEncoding("utf8")
    sock.on("data", (c) => {
      buf += c
    })
    sock.on("end", () => {
      const status = Number(buf.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? "0")
      resolve({ status, body: buf.slice(buf.indexOf("\r\n\r\n") + 4) })
    })
    sock.on("error", reject)
  })

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
      if (buf === "") reject(new Error("closed with no response"))
    })
  })

describe("secret-egress e2e — plaintext-HTTP body/header scan", () => {
  test("declared secret in a POST body → 403 deny, logged `denied`", async () => {
    received = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: ["allowed.test"],
        secretEgress: egress({ declared: [DECLARED] }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, "http://allowed.test/hook", `data=${DECLARED}`)
      expect(res.status).toBe(403)
      expect(res.body).toContain("outbound secret detected")
      expect(res.body.includes(DECLARED)).toBe(false) // never echo the secret
      const last = proxy.decisionLog().at(-1)
      expect(last?.secretScan).toBe("denied")
      expect(received).toHaveLength(0) // never reached origin
    } finally {
      await proxy.close()
    }
  })

  test("AWS-key (pattern) in a POST body → 403 deny", async () => {
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"], secretEgress: egress() },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, "http://allowed.test/", `grant=${AWS_KEY}`)
      expect(res.status).toBe(403)
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("denied")
    } finally {
      await proxy.close()
    }
  })

  test("declared secret in a request HEADER value → 403 deny", async () => {
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: ["allowed.test"],
        secretEgress: egress({ declared: [DECLARED] }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(
        port,
        "http://allowed.test/",
        "clean-body",
        `X-Token: ${DECLARED}`,
      )
      expect(res.status).toBe(403)
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("denied")
    } finally {
      await proxy.close()
    }
  })

  test("redact mode: declared secret masked, request forwarded, origin sees the mask", async () => {
    received = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: ["allowed.test"],
        secretEgress: egress({ declared: [DECLARED], mode: "redact" }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, "http://allowed.test/", `data=${DECLARED}`)
      expect(res.status).toBe(200)
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("redacted")
      // The origin received a redacted body — the raw secret never left.
      expect(received.length).toBe(1)
      expect(received[0]?.includes(DECLARED)).toBe(false)
      expect(received[0]).toContain("[REDACTED:secret-egress]")
    } finally {
      await proxy.close()
    }
  })
})

describe("secret-egress e2e — NO false positive", () => {
  test("a legit body → 200, forwarded unchanged, logged `scanned-clean`", async () => {
    received = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: ["allowed.test"],
        secretEgress: egress({ declared: [DECLARED] }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, "http://allowed.test/", "hello=world&count=42")
      expect(res.status).toBe(200)
      expect(res.body).toBe("ORIGIN-OK")
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("scanned-clean")
      expect(received[0]).toBe("hello=world&count=42")
    } finally {
      await proxy.close()
    }
  })
})

describe("secret-egress e2e — HONEST HTTPS gap is VISIBLE", () => {
  test("a CONNECT tunnel is logged `connect-tunnel-unscanned` (not a silent claim)", async () => {
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"], secretEgress: egress() },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const status = await proxyConnect(port, "allowed.test:443")
      expect(status).toBe(200) // tunnel granted (host allowed) …
      // … but the body was NOT scanned — and that gap is EXPLICIT in the log.
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("connect-tunnel-unscanned")
    } finally {
      await proxy.close()
    }
  })
})

describe("secret-egress e2e — body-cap DoS guard", () => {
  test("a body over the cap is forwarded UNSCANNED (`body-cap-unscanned`), never truncated-block", async () => {
    received = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: ["allowed.test"],
        secretEgress: egress({ declared: [DECLARED], maxBodyBytes: 16 }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      // Body well over the 16-byte cap AND carrying the secret — proves we do
      // NOT block-by-truncation: it forwards unscanned with a visible marker.
      const big = `xxxxxxxxxxxxxxxxxxxxxxxx${DECLARED}`
      const res = await proxyPost(port, "http://allowed.test/", big)
      expect(res.status).toBe(200)
      expect(proxy.decisionLog().at(-1)?.secretScan).toBe("body-cap-unscanned")
    } finally {
      await proxy.close()
    }
  })
})

describe("secret-egress e2e — default-OFF byte-identity", () => {
  test("secretEgress absent ⇒ host-only decision, no secretScan field", async () => {
    received = []
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, "http://allowed.test/", `data=${DECLARED}`)
      expect(res.status).toBe(200) // forwarded — host-only, no content scan
      const last = proxy.decisionLog().at(-1)
      expect(last?.decision).toBe("allow")
      expect(last?.secretScan).toBeUndefined() // byte-identical log entry
      expect(received[0]).toBe(`data=${DECLARED}`) // unchanged
    } finally {
      await proxy.close()
    }
  })
})
