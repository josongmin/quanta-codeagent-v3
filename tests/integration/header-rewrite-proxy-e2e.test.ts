/**
 * ticket-13 (§12.2) — outbound header-rewrite REAL-socket e2e (plain + MITM).
 *
 * Hermetic + offline: a local origin stands in for "the internet" and CAPTURES
 * the request headers it received, so we can assert the rewrite reached upstream.
 * We drive ACTUAL client sockets through the LoopbackEgressProxy and assert:
 *   - plaintext-HTTP: strip / set / append / rewrite each reach the origin.
 *   - the FORBIDDEN-INJECT guard refuses a `set authorization` (the origin never
 *     sees an injected credential) + the value-free audit log records it.
 *   - REDACTION BEATS rewrite: a `rewrite` of a header whose value carries a
 *     declared secret can NOT revive it — the secret-egress drop wins.
 *   - the mutation audit log is value-redacted (never carries the rule value).
 *   - DEFAULT-OFF: no headerRules ⇒ the origin sees the ORIGINAL headers
 *     (byte-identical) and the header-rule log is empty.
 *   - MITM (TLS) path: the SAME strip/set rules reach the origin over real HTTPS.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import { type AddressInfo, connect as netConnect } from "node:net"
import { connect as tlsConnect } from "node:tls"
import {
  type DialTarget,
  type HeaderRule,
  LoopbackEgressProxy,
  MitmCertAuthority,
  type MitmConfig,
  nodeKeyPairSource,
  type ResolvePeerHost,
  type SecretEgressConfig,
} from "@/../src/runtime/network-proxy"
import { compositeSecretScanner } from "@/security/secret-detection"

const DECLARED = "s3cr3t-deploy-token-do-not-leak"
const HOST = "allowed.test"

// ── plaintext origin ────────────────────────────────────────────────────────
let origin: Server
let originPort: number
/** Header maps the plain origin actually received (to assert the rewrite). */
let receivedHeaders: IncomingMessage["headers"][] = []
let receivedBodies: string[] = []

const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })
const publicPeer: ResolvePeerHost = () => "203.0.113.10"
const hermetic = (): { dial: DialTarget; resolvePeerHost: ResolvePeerHost } => ({
  dial: toOrigin(),
  resolvePeerHost: publicPeer,
})

const egress = (over: Partial<SecretEgressConfig> = {}): SecretEgressConfig => ({
  scanner: compositeSecretScanner(),
  mode: "redact",
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
      receivedHeaders.push(req.headers)
      receivedBodies.push(body)
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

/** Send an absolute-form proxy POST with a body + optional extra header lines. */
const proxyPost = (
  proxyPort: number,
  absoluteUrl: string,
  body: string,
  extraHeaders: string[] = [],
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      const host = new URL(absoluteUrl).host
      const len = Buffer.byteLength(body)
      const xh = extraHeaders.map((h) => `${h}\r\n`).join("")
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

describe("header-rewrite e2e — plaintext-HTTP reaches the origin", () => {
  const runWith = async (
    rules: readonly HeaderRule[],
    extraHeaders: string[],
  ): Promise<IncomingMessage["headers"]> => {
    receivedHeaders = []
    receivedBodies = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: [HOST],
        secretEgress: egress({ headerRules: rules }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, `http://${HOST}/hook`, "hello=world", extraHeaders)
      expect(res.status).toBe(200)
      return receivedHeaders[0] ?? {}
    } finally {
      await proxy.close()
    }
  }

  test("strip removes a header before it reaches upstream", async () => {
    const got = await runWith([{ name: "x-trace", op: "strip" }], ["X-Trace: leaky"])
    expect(got["x-trace"]).toBeUndefined()
  })

  test("set creates/overwrites a header at upstream", async () => {
    const got = await runWith([{ name: "x-source", op: "set", value: "quanta" }], [])
    expect(got["x-source"]).toBe("quanta")
  })

  test("append produces a MULTI-VALUE header at upstream", async () => {
    const got = await runWith(
      [
        { name: "x-tag", op: "set", value: "one" },
        { name: "x-tag", op: "append", value: "two" },
      ],
      [],
    )
    // node:http joins repeated request headers with ", " on the receiving side.
    expect(got["x-tag"]).toBe("one, two")
  })

  test("rewrite replaces an EXISTING header but does NOT create an absent one", async () => {
    const present = await runWith(
      [{ name: "user-agent", op: "rewrite", value: "quanta/1" }],
      ["User-Agent: curl/8"],
    )
    expect(present["user-agent"]).toBe("quanta/1")

    const absent = await runWith([{ name: "x-none", op: "rewrite", value: "v" }], [])
    expect(absent["x-none"]).toBeUndefined()
  })
})

describe("header-rewrite e2e — FORBIDDEN-INJECT guard", () => {
  test("set authorization is refused: the origin NEVER sees an injected credential", async () => {
    receivedHeaders = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: [HOST],
        secretEgress: egress({
          headerRules: [{ name: "authorization", op: "set", value: "Bearer forged" }],
        }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, `http://${HOST}/hook`, "x")
      expect(res.status).toBe(200)
      // The forged credential never reached upstream …
      expect(receivedHeaders[0]?.authorization).toBeUndefined()
      // … and the refusal is VISIBLE in the value-free audit log.
      const last = proxy.headerRuleLog().at(-1)
      expect(last?.fired).toBe(false)
      expect(last?.refused).toBe("forbidden-inject")
      expect(JSON.stringify(proxy.headerRuleLog()).includes("forged")).toBe(false)
    } finally {
      await proxy.close()
    }
  })
})

describe("header-rewrite e2e — REDACTION beats rewrite", () => {
  test("a rewrite cannot revive a header whose declared secret was redacted", async () => {
    receivedHeaders = []
    receivedBodies = []
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: [HOST],
        secretEgress: egress({
          declared: [DECLARED],
          mode: "redact",
          // The rule targets the SAME header the secret rode in — but redaction
          // drops that header FIRST, and rewrite only acts if present, so it
          // cannot revive it. (Order: redaction → header-rules.)
          headerRules: [{ name: "x-token", op: "rewrite", value: "should-not-appear" }],
        }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, `http://${HOST}/hook`, "clean=body", [
        `X-Token: ${DECLARED}`,
      ])
      expect(res.status).toBe(200)
      const got = receivedHeaders[0] ?? {}
      // The header that carried the declared secret was DROPPED by redaction …
      expect(got["x-token"]).toBeUndefined()
      // … and the rewrite (rewrite-only-if-present) could NOT recreate it.
      expect(got["x-token"]).not.toBe("should-not-appear")
      // The raw secret never reached upstream in any header value.
      expect(JSON.stringify(got).includes(DECLARED)).toBe(false)
    } finally {
      await proxy.close()
    }
  })
})

describe("header-rewrite e2e — mutation audit log is value-redacted", () => {
  test("a fired set rule logs index/name/op/fired/host but NEVER the value", async () => {
    const proxy = new LoopbackEgressProxy(
      {
        enabled: true,
        allowlist: [HOST],
        secretEgress: egress({
          headerRules: [{ name: "x-mark", op: "set", value: "sensitive-marker-value" }],
        }),
      },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      await proxyPost(port, `http://${HOST}/hook`, "x")
      const entry = proxy.headerRuleLog().find((e) => e.headerName === "x-mark")
      expect(entry).toBeDefined()
      expect(entry?.fired).toBe(true)
      expect(entry?.op).toBe("set")
      expect(entry?.index).toBe(0)
      expect(entry?.host).toBe(HOST)
      expect(JSON.stringify(proxy.headerRuleLog()).includes("sensitive-marker-value")).toBe(false)
    } finally {
      await proxy.close()
    }
  })
})

describe("header-rewrite e2e — DEFAULT-OFF byte-identity", () => {
  test("no headerRules ⇒ origin sees the ORIGINAL headers + empty header-rule log", async () => {
    receivedHeaders = []
    const proxy = new LoopbackEgressProxy(
      // secretEgress present (so the buffered path runs) but NO headerRules.
      { enabled: true, allowlist: [HOST], secretEgress: egress() },
      hermetic(),
    )
    const { port } = await proxy.listen()
    try {
      const res = await proxyPost(port, `http://${HOST}/hook`, "hello=world", ["X-Keep: yes"])
      expect(res.status).toBe(200)
      expect(receivedHeaders[0]?.["x-keep"]).toBe("yes") // untouched
      expect(proxy.headerRuleLog()).toHaveLength(0) // nothing fired
    } finally {
      await proxy.close()
    }
  })
})

// ── MITM (real TLS) path ─────────────────────────────────────────────────────
const VALIDITY = { notBeforeMs: -86_400_000, notAfterMs: 86_400_000 }
let counter = 0
const serial = (): number => ++counter
const upstreamCa = new MitmCertAuthority({
  keyPairSource: nodeKeyPairSource,
  serialSource: serial,
  now: () => Date.now(),
  validity: VALIDITY,
})

let tlsOrigin: HttpsServer
let tlsOriginPort: number
let tlsReceivedHeaders: IncomingMessage["headers"][] = []

const toTlsOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: tlsOriginPort })

const mitmConfig = (over: Partial<MitmConfig> = {}): MitmConfig => ({
  certAuthority: new MitmCertAuthority({
    keyPairSource: nodeKeyPairSource,
    serialSource: serial,
    now: () => Date.now(),
    validity: VALIDITY,
  }),
  secretEgress: egress({ mode: "deny" }),
  onFailure: "deny",
  handshakeTimeoutMs: 1_500,
  ...over,
})

const httpsThroughProxy = (
  proxyPort: number,
  mitmCaPem: string,
  body: string,
): Promise<{ status: number; body: string; err?: string }> =>
  new Promise((resolve) => {
    const ctrl = netConnect(proxyPort, "127.0.0.1", () => {
      ctrl.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
    })
    let connBuf = ""
    const onConnectData = (c: Buffer): void => {
      connBuf += c.toString("latin1")
      if (connBuf.includes("\r\n\r\n")) {
        ctrl.removeListener("data", onConnectData)
        if (!connBuf.startsWith("HTTP/1.1 200")) {
          resolve({
            status: Number(connBuf.match(/HTTP\/1\.1 (\d{3})/)?.[1] ?? 0),
            body: "",
            err: "connect-failed",
          })
          ctrl.destroy()
          return
        }
        const tls = tlsConnect({ socket: ctrl, servername: HOST, ca: [mitmCaPem] }, () => {
          const len = Buffer.byteLength(body)
          tls.write(
            `POST /hook HTTP/1.1\r\nHost: ${HOST}\r\nX-Trace: leaky\r\nContent-Length: ${len}\r\nConnection: close\r\n\r\n${body}`,
          )
        })
        let resp = ""
        tls.setEncoding("utf8")
        tls.on("data", (d: string | Buffer) => {
          resp += d
        })
        tls.on("end", () => {
          const status = Number(resp.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)
          resolve({ status, body: resp.slice(resp.indexOf("\r\n\r\n") + 4) })
          ctrl.destroy()
        })
        tls.on("error", (e: Error) => {
          resolve({ status: 0, body: "", err: e.message })
          ctrl.destroy()
        })
      }
    }
    ctrl.on("data", onConnectData)
    ctrl.on("error", (e) => resolve({ status: 0, body: "", err: e.message }))
  })

describe("header-rewrite e2e — MITM (real TLS) reaches the origin", () => {
  beforeAll(async () => {
    const originLeaf = upstreamCa.leafFor(HOST)
    tlsOrigin = createHttpsServer(
      { key: originLeaf.keyPem, cert: originLeaf.certPem },
      (req, res) => {
        // Drain the body (so `end` fires) — we only assert on the headers here.
        req.resume()
        req.on("end", () => {
          tlsReceivedHeaders.push(req.headers)
          res.writeHead(200, { "content-type": "text/plain" })
          res.end("ORIGIN-OK")
        })
      },
    )
    await new Promise<void>((resolve) => tlsOrigin.listen(0, "127.0.0.1", () => resolve()))
    tlsOriginPort = (tlsOrigin.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => tlsOrigin.close(() => resolve()))
  })

  test("strip + set rules reach the HTTPS origin through MITM", async () => {
    tlsReceivedHeaders = []
    const mitm = mitmConfig({
      headerRules: [
        { name: "x-trace", op: "strip" },
        { name: "x-source", op: "set", value: "quanta-mitm" },
      ],
    })
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: [HOST], secretEgress: mitm.secretEgress, mitm },
      {
        dial: toTlsOrigin(),
        resolvePeerHost: publicPeer,
        upstreamTlsExtra: () => ({ ca: upstreamCa.caCertPem() }),
      },
    )
    const { port } = await proxy.listen()
    try {
      const res = await httpsThroughProxy(port, mitm.certAuthority.caCertPem(), "hello=world")
      expect(res.status).toBe(200)
      const got = tlsReceivedHeaders[0] ?? {}
      expect(got["x-trace"]).toBeUndefined() // stripped
      expect(got["x-source"]).toBe("quanta-mitm") // set
      // The MITM header-rule mutation is in the value-free audit log too.
      expect(proxy.headerRuleLog().some((e) => e.headerName === "x-source" && e.fired)).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  test("MITM default-OFF: no headerRules ⇒ origin sees the original X-Trace", async () => {
    tlsReceivedHeaders = []
    const mitm = mitmConfig() // no headerRules
    const proxy = new LoopbackEgressProxy(
      { enabled: true, allowlist: [HOST], secretEgress: mitm.secretEgress, mitm },
      {
        dial: toTlsOrigin(),
        resolvePeerHost: publicPeer,
        upstreamTlsExtra: () => ({ ca: upstreamCa.caCertPem() }),
      },
    )
    const { port } = await proxy.listen()
    try {
      const res = await httpsThroughProxy(port, mitm.certAuthority.caCertPem(), "hello=world")
      expect(res.status).toBe(200)
      expect(tlsReceivedHeaders[0]?.["x-trace"]).toBe("leaky") // untouched
      expect(proxy.headerRuleLog()).toHaveLength(0)
    } finally {
      await proxy.close()
    }
  })
})
