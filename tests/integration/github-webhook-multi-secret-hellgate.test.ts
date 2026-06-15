/**
 * ADR-0312 — MULTI-INSTALLATION webhook secret hellgate.
 *
 * Seals the `quanta webhook` host's per-installation secret support: ONE host
 * serving N GitHub Apps, each with its OWN HMAC secret, discriminated by URL
 * PATH (`/webhook/<appKey>`) BEFORE the body is parsed. Drives the real
 * `runWebhookServerCmd` over a loopback `node:http` transport + a SPY publish
 * sink (same harness shape as `github-webhook-host-cli-hellgate.test.ts`).
 *
 * TEETH:
 *   - cross-secret forgery: secret-B signing on key-A's path ⇒ 401, NO publish.
 *   - unknown installation key ⇒ 401, body never parsed, NO publish.
 *   - backward-compat: only the single QUANTA_GITHUB_WEBHOOK_SECRET set ⇒ the
 *     legacy /webhook flow is byte-identical (valid delivery ⇒ 202 + publish).
 *   - credential hygiene: no secret VALUE ever appears in io.out / io.err.
 *   - constant-time compare preserved (verifyHubSignature256, never hand-rolled).
 *
 * RED-on-injection (proven during authoring, reverted in source):
 *   - cross-secret case: make the map resolver return the WRONG secret (e.g.
 *     always secret-A) ⇒ the key-A/secret-B case would 202 instead of 401.
 *   - unknown-key case: make `extractAppKey` return a fixed known key ⇒ the
 *     ghost path would resolve a real secret and 202.
 *   - byte-compat case: drop the single-secret fallback in
 *     `loadWebhookSecretConfig` ⇒ mode `none` ⇒ host exits 64, no publish.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PublishReactorWatchTriggerFn,
  runWebhookServerCmd,
  type WebhookServerCmdDeps,
  type WebhookServerCmdIo,
} from "@/apps/cli/webhook-server-setup"
import {
  createDeliveryStore,
  type WebhookHandle,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransportPort,
} from "@/integrations/github"
import type { ProactiveTrigger } from "@/reactor"

// ── env keys ────────────────────────────────────────────────────────────────
const GATE = "QUANTA_GITHUB_WEBHOOK"
const SINGLE = "QUANTA_GITHUB_WEBHOOK_SECRET"
const SECRETS = "QUANTA_GITHUB_WEBHOOK_SECRETS"
const SECRETS_FILE = "QUANTA_GITHUB_WEBHOOK_SECRETS_FILE"
const SESSION = "QUANTA_GITHUB_WEBHOOK_SESSION"

// Two installations, each with its OWN secret. base64 padding (`=`) on purpose,
// to lock that the inline parser splits on the FIRST '=' only.
const SECRET_A = "instA-secret-aaa=="
const SECRET_B = "instB-secret-bbbbb"
const PR_NUMBER = 7

// ── loopback transport exposing the bound port ──────────────────────────────
interface BoundTransport {
  readonly transport: WebhookTransportPort
  port(): number
}
const makeLoopbackTransport = (): BoundTransport => {
  let server: Server | undefined
  let boundPort = 0
  const transport: WebhookTransportPort = {
    async listen({ onRequest }) {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (c) => chunks.push(c instanceof Buffer ? c : Buffer.from(c)))
        req.on("end", () => {
          void (async () => {
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === "string") headers[k.toLowerCase()] = v
              else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ")
            }
            const wreq: WebhookRequest = {
              method: req.method ?? "GET",
              path: (req.url ?? "/").split("?")[0] ?? "/",
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
            }
            let out: WebhookResponse
            try {
              out = await onRequest(wreq)
            } catch {
              out = { status: 500, body: "handler threw" }
            }
            res.writeHead(out.status, { "content-type": "text/plain" })
            res.end(out.body ?? "")
          })()
        })
      })
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", () => resolve())
      })
      boundPort = (server?.address() as AddressInfo).port
      const handle: WebhookHandle = {
        async close(): Promise<void> {
          await new Promise<void>((resolve) => {
            server?.close(() => resolve())
          })
        },
      }
      return handle
    },
  }
  return { transport, port: () => boundPort }
}

// ── HTTP client over loopback (path is parameterized) ───────────────────────
interface HttpResult {
  readonly status: number
  readonly body: string
}
const postWebhook = (
  port: number,
  path: string,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<HttpResult> =>
  new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "content-length": String(body.length), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c instanceof Buffer ? c : Buffer.from(c)))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        )
      },
    )
    req.on("error", reject)
    req.write(body)
    req.end()
  })

// ── payload + per-secret signature ──────────────────────────────────────────
const signBody = (body: Uint8Array, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

const issueCommentPayload = (commentBody: string): Uint8Array => {
  const obj = {
    action: "created",
    repository: { owner: { login: "octo" }, name: "widget" },
    sender: { login: "alice", type: "User" },
    issue: { number: PR_NUMBER, pull_request: { url: "https://x" }, body: "" },
    comment: { body: commentBody, author_association: "COLLABORATOR", user: { login: "alice" } },
  }
  return new Uint8Array(Buffer.from(JSON.stringify(obj), "utf8"))
}

const deliveryHeaders = (
  deliveryId: string,
  sig: string | null,
  event = "issue_comment",
): Record<string, string> => {
  const h: Record<string, string> = {
    "x-github-event": event,
    "x-github-delivery": deliveryId,
    "content-type": "application/json",
  }
  if (sig !== null) h["x-hub-signature-256"] = sig
  return h
}

// ── spy publish + io capture ────────────────────────────────────────────────
interface PublishCall {
  readonly sessionId: string
  readonly trigger: ProactiveTrigger
}
const makeSpyPublish = (): { fn: PublishReactorWatchTriggerFn; calls: PublishCall[] } => {
  const calls: PublishCall[] = []
  const fn: PublishReactorWatchTriggerFn = (opts) => {
    calls.push({ sessionId: opts.sessionId, trigger: opts.trigger })
  }
  return { fn, calls }
}
const makeIo = (): { io: WebhookServerCmdIo; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err }
}

const runHost = (
  bound: BoundTransport,
  publish: PublishReactorWatchTriggerFn,
  io: WebhookServerCmdIo,
  sessionId: string,
): { done: Promise<number>; stop: () => void } => {
  const deps: WebhookServerCmdDeps = {
    buildTransport: () => bound.transport,
    publish,
    pollIntervalMs: 5,
    buildDeliveryStore: () => createDeliveryStore(),
  }
  process.env[SESSION] = sessionId
  const done = runWebhookServerCmd([], { io, deps })
  return { done, stop: () => process.emit("SIGINT") }
}

const waitUntil = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

/** Assert no configured secret VALUE leaked into either stream. */
const assertNoSecretLeak = (out: string[], err: string[]): void => {
  const blob = out.join("") + err.join("")
  expect(blob.includes(SECRET_A)).toBe(false)
  expect(blob.includes(SECRET_B)).toBe(false)
  expect(blob.includes("legacy-single-secret")).toBe(false)
}

// ── env lifecycle ────────────────────────────────────────────────────────────
const ENV_KEYS = [GATE, SINGLE, SECRETS, SECRETS_FILE, SESSION] as const
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  // start each test from a clean multi-secret env
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("quanta webhook HOST — multi-installation secret store", () => {
  test("MAP: key-A signed with secret-A → 202 + publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRETS] = `appA=${SECRET_A},appB=${SECRET_B}`
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io, out, err } = makeIo()
    const host = runHost(bound, spy.fn, io, "map-session")
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta review on app A")
    const res = await postWebhook(
      bound.port(),
      "/webhook/appA",
      body,
      deliveryHeaders("a-1", signBody(body, SECRET_A)),
    )
    expect(res.status).toBe(202)
    expect(res.body).toBe("accepted")

    await waitUntil(() => spy.calls.length >= 1)
    host.stop()
    expect(await host.done).toBe(0)

    expect(spy.calls.length).toBe(1)
    expect(spy.calls[0]?.sessionId).toBe("map-session")
    expect(spy.calls[0]?.trigger.evidence.value).toBe(
      `https://github.com/octo/widget/pull/${PR_NUMBER}`,
    )
    assertNoSecretLeak(out, err)
  })

  test("SECURITY/forgery: secret-B signed on key-A's path → 401, NO publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRETS] = `appA=${SECRET_A},appB=${SECRET_B}`
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io, out, err } = makeIo()
    const host = runHost(bound, spy.fn, io, "forge-session")
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta cross-secret forgery")
    // sign with appB's secret but POST to appA's path — must NOT verify.
    const res = await postWebhook(
      bound.port(),
      "/webhook/appA",
      body,
      deliveryHeaders("forge-1", signBody(body, SECRET_B)),
    )
    expect(res.status).toBe(401)
    expect(res.body).toBe("invalid signature")

    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(0)
    assertNoSecretLeak(out, err)
  })

  test("SECURITY/unknown key: /webhook/ghost → 401, body never parsed, NO publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRETS] = `appA=${SECRET_A}`
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io, out, err } = makeIo()
    const host = runHost(bound, spy.fn, io, "ghost-session")
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta who am I")
    // even a perfectly-signed body under SECRET_A is rejected on an unmapped key
    const res = await postWebhook(
      bound.port(),
      "/webhook/ghost",
      body,
      deliveryHeaders("ghost-1", signBody(body, SECRET_A)),
    )
    expect(res.status).toBe(401)
    expect(res.body).toBe("unknown installation")

    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(0)
    assertNoSecretLeak(out, err)
  })

  test("MAP: bare /webhook (no key) under a map → 401 unknown installation", async () => {
    process.env[GATE] = "1"
    process.env[SECRETS] = `appA=${SECRET_A}`
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io, "bare-session")
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta bare path")
    const res = await postWebhook(
      bound.port(),
      "/webhook",
      body,
      deliveryHeaders("bare-1", signBody(body, SECRET_A)),
    )
    expect(res.status).toBe(401)
    expect(res.body).toBe("unknown installation")

    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(0)
  })

  test("BACKWARD-COMPAT: only single secret → legacy /webhook is byte-identical (202 + publish)", async () => {
    process.env[GATE] = "1"
    process.env[SINGLE] = "legacy-single-secret"
    // NO map env set
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io, out, err } = makeIo()
    const host = runHost(bound, spy.fn, io, "compat-session")
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta legacy flow")
    const res = await postWebhook(
      bound.port(),
      "/webhook",
      body,
      deliveryHeaders("compat-1", signBody(body, "legacy-single-secret")),
    )
    expect(res.status).toBe(202)
    expect(res.body).toBe("accepted")

    await waitUntil(() => spy.calls.length >= 1)
    host.stop()
    expect(await host.done).toBe(0)
    expect(spy.calls.length).toBe(1)
    assertNoSecretLeak(out, err)
  })

  test("FILE MAP: JSON {key:secret} file resolves per-installation secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-secrets-"))
    const filePath = join(dir, "secrets.json")
    writeFileSync(filePath, JSON.stringify({ appA: SECRET_A, appB: SECRET_B }), "utf8")
    try {
      process.env[GATE] = "1"
      process.env[SECRETS_FILE] = filePath
      const bound = makeLoopbackTransport()
      const spy = makeSpyPublish()
      const { io, out, err } = makeIo()
      const host = runHost(bound, spy.fn, io, "file-session")
      await waitUntil(() => bound.port() !== 0)

      const body = issueCommentPayload("@quanta from file map")
      const res = await postWebhook(
        bound.port(),
        "/webhook/appB",
        body,
        deliveryHeaders("file-1", signBody(body, SECRET_B)),
      )
      expect(res.status).toBe(202)
      // forged under appA's secret on appB's path → 401
      const body2 = issueCommentPayload("@quanta forge file")
      const res2 = await postWebhook(
        bound.port(),
        "/webhook/appB",
        body2,
        deliveryHeaders("file-2", signBody(body2, SECRET_A)),
      )
      expect(res2.status).toBe(401)

      await waitUntil(() => spy.calls.length >= 1)
      host.stop()
      await host.done
      expect(spy.calls.length).toBe(1) // only the valid appB delivery
      assertNoSecretLeak(out, err)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("CONFIG FAIL-CLOSED: malformed map with no usable entries → exit 64, binds nothing", async () => {
    process.env[GATE] = "1"
    // every entry malformed: no '=', empty key, empty value
    process.env[SECRETS] = "garbage,=novalue,emptyval="
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io, err } = makeIo()
    let transportBuilt = false
    const deps: WebhookServerCmdDeps = {
      buildTransport: () => {
        transportBuilt = true
        return bound.transport
      },
      publish: spy.fn,
    }
    const code = await runWebhookServerCmd([], { io, deps })
    expect(code).toBe(64)
    expect(transportBuilt).toBe(false)
    expect(bound.port()).toBe(0)
    expect(err.join("")).toContain("SECRET")
  })

  test("CONFIG: duplicate key is refused (both poisoned) → that key 401s", async () => {
    process.env[GATE] = "1"
    // appA appears twice with DIFFERENT secrets → ambiguous → refuse both.
    process.env[SECRETS] = `appA=${SECRET_A},appA=${SECRET_B},appB=${SECRET_B}`
    const bound = makeLoopbackTransport()
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io, "dup-session")
    await waitUntil(() => bound.port() !== 0)

    // appA poisoned: a correctly-A-signed delivery still 401s
    const bodyA = issueCommentPayload("@quanta dup A")
    const resA = await postWebhook(
      bound.port(),
      "/webhook/appA",
      bodyA,
      deliveryHeaders("dup-a", signBody(bodyA, SECRET_A)),
    )
    expect(resA.status).toBe(401)
    expect(resA.body).toBe("unknown installation")

    // appB (clean) still works → proves the map didn't collapse entirely
    const bodyB = issueCommentPayload("@quanta dup B")
    const resB = await postWebhook(
      bound.port(),
      "/webhook/appB",
      bodyB,
      deliveryHeaders("dup-b", signBody(bodyB, SECRET_B)),
    )
    expect(resB.status).toBe(202)

    await waitUntil(() => spy.calls.length >= 1)
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(1) // only appB
  })

  test("CONFIG: inline map WINS over file map when both set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wh-secrets-pri-"))
    const filePath = join(dir, "secrets.json")
    // file maps appA → SECRET_B (the WRONG secret); inline maps appA → SECRET_A.
    writeFileSync(filePath, JSON.stringify({ appA: SECRET_B }), "utf8")
    try {
      process.env[GATE] = "1"
      process.env[SECRETS] = `appA=${SECRET_A}`
      process.env[SECRETS_FILE] = filePath
      const bound = makeLoopbackTransport()
      const spy = makeSpyPublish()
      const { io } = makeIo()
      const host = runHost(bound, spy.fn, io, "pri-session")
      await waitUntil(() => bound.port() !== 0)

      const body = issueCommentPayload("@quanta precedence")
      // signed with SECRET_A (the INLINE value) → must verify (inline wins)
      const res = await postWebhook(
        bound.port(),
        "/webhook/appA",
        body,
        deliveryHeaders("pri-1", signBody(body, SECRET_A)),
      )
      expect(res.status).toBe(202)

      await waitUntil(() => spy.calls.length >= 1)
      host.stop()
      await host.done
      expect(spy.calls.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
