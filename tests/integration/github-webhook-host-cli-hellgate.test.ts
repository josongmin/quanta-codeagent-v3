/**
 * ADR-0312 — `quanta webhook` HOST/SURFACE hellgate.
 *
 * The slice (`createWebhookEventSource` + transports + HMAC verify) is LIVE and
 * sealed by `github-webhook-dispatch-e2e.test.ts`. THIS suite seals the missing
 * HOST layer (`runWebhookServerCmd` in `apps/cli/webhook-server-setup.ts`): the
 * gate, the secret fence, and the NEW poll→publish PUMP that drains the source
 * into the reactor-watch IPC sink.
 *
 * Drive: `runWebhookServerCmd` with (a) an injected loopback transport bound on
 * an ephemeral port (the prod pipeline runs UNCHANGED behind it — this is the
 * surface seam, not a slice reimplementation) and (b) a SPY publish sink. A real
 * HTTP client POSTs over loopback; we await the pump and assert what the sink
 * received.
 *
 * RED-on-injection: mutating the pump to skip `publish(...)` turns the WIRING
 * case red (proven below, then reverted in source).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
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

// ── Constants ────────────────────────────────────────────────────────────
const SECRET = "host-cli-webhook-secret"
const PR_NUMBER = 7
const GATE = "QUANTA_GITHUB_WEBHOOK"
const SECRET_ENV = "QUANTA_GITHUB_WEBHOOK_SECRET"

// ── Real loopback node:http transport exposing the bound port ──────────────
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

// ── Real HTTP client over loopback ─────────────────────────────────────────
interface HttpResult {
  readonly status: number
  readonly body: string
}

const postWebhook = (
  port: number,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<HttpResult> =>
  new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/webhook",
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

// ── Payload + signature helpers ────────────────────────────────────────────
const signBody = (body: Uint8Array): string =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`

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
  body: Uint8Array,
  deliveryId: string,
  opts?: { event?: string; sig?: string | null },
): Record<string, string> => {
  const h: Record<string, string> = {
    "x-github-event": opts?.event ?? "issue_comment",
    "x-github-delivery": deliveryId,
    "content-type": "application/json",
  }
  if (opts?.sig !== null) h["x-hub-signature-256"] = opts?.sig ?? signBody(body)
  return h
}

// ── Spy publish sink ───────────────────────────────────────────────────────
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

// ── IO capture (no real process streams) ───────────────────────────────────
const makeIo = (): { io: WebhookServerCmdIo; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err }
}

/**
 * Boot the command in the background and return a handle that drives a single
 * cycle and stops. The command runs a long-lived pump, so we run it detached and
 * SIGINT it to resolve. `pollIntervalMs` is tiny so the pump drains promptly.
 */
const runHost = (
  bound: BoundTransport,
  publish: PublishReactorWatchTriggerFn,
  io: WebhookServerCmdIo,
  sessionId = "test-session",
  extra?: Partial<WebhookServerCmdDeps>,
): { done: Promise<number>; stop: () => void } => {
  const deps: WebhookServerCmdDeps = {
    buildTransport: () => bound.transport,
    publish,
    pollIntervalMs: 5,
    // Hermetic default: in-memory dedup (no real-fs write). Tests that need the
    // DURABLE cross-restart behaviour pass `extra.buildDeliveryStore`.
    buildDeliveryStore: () => createDeliveryStore(),
    ...extra,
  }
  const prev = process.env.QUANTA_GITHUB_WEBHOOK_SESSION
  process.env.QUANTA_GITHUB_WEBHOOK_SESSION = sessionId
  const done = runWebhookServerCmd([], { io, deps }).finally(() => {
    if (prev === undefined) delete process.env.QUANTA_GITHUB_WEBHOOK_SESSION
    else process.env.QUANTA_GITHUB_WEBHOOK_SESSION = prev
  })
  return { done, stop: () => process.emit("SIGINT") }
}

const waitUntil = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

// ── env lifecycle ──────────────────────────────────────────────────────────
let savedGate: string | undefined
let savedSecret: string | undefined
let bound: BoundTransport

beforeEach(() => {
  savedGate = process.env[GATE]
  savedSecret = process.env[SECRET_ENV]
  bound = makeLoopbackTransport()
})

afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]
  else process.env[GATE] = savedGate
  if (savedSecret === undefined) delete process.env[SECRET_ENV]
  else process.env[SECRET_ENV] = savedSecret
})

describe("quanta webhook HOST — gate, secret fence, poll→publish pump", () => {
  test("WIRING: valid HMAC + @quanta mention → 202 + trigger published to sink", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io, "wire-session")

    // give the listener a beat to bind
    await waitUntil(() => bound.port() !== 0)
    const body = issueCommentPayload("@quanta please review this")
    const res = await postWebhook(bound.port(), body, deliveryHeaders(body, "wire-1"))
    expect(res.status).toBe(202)
    expect(res.body).toBe("accepted")

    // the PUMP must drain poll()→publish
    await waitUntil(() => spy.calls.length >= 1)
    host.stop()
    const code = await host.done
    expect(code).toBe(0)

    // unconditional then narrow
    expect(spy.calls.length).toBe(1)
    const call = spy.calls[0]
    expect(call?.sessionId).toBe("wire-session")
    expect(call?.trigger.reason).toBe("pr_comment")
    expect(call?.trigger.evidence.kind).toBe("url")
    expect(call?.trigger.evidence.value).toBe(`https://github.com/octo/widget/pull/${PR_NUMBER}`)
    expect(call?.trigger.simulatedMessage).toContain("@alice")
  })

  test("SECURITY: invalid signature → 401, NO publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io)
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta hi")
    const forged = `sha256=${createHmac("sha256", "attacker").update(body).digest("hex")}`
    const res = await postWebhook(
      bound.port(),
      body,
      deliveryHeaders(body, "forged-1", { sig: forged }),
    )
    expect(res.status).toBe(401)

    // let any (erroneous) pump cycle run, then assert nothing leaked
    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(0)
  })

  test("SECURITY: missing X-Hub-Signature-256 → 401, no publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io)
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta hi")
    const res = await postWebhook(
      bound.port(),
      body,
      deliveryHeaders(body, "nosig-1", { sig: null }),
    )
    expect(res.status).toBe(401)

    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(0)
  })

  test("SECRET FENCE: empty secret → exit 64, binds nothing", async () => {
    process.env[GATE] = "1"
    delete process.env[SECRET_ENV]
    const spy = makeSpyPublish()
    const { io, err } = makeIo()
    // buildTransport must NEVER be called when the secret is empty.
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
    expect(bound.port()).toBe(0) // nothing ever bound
    expect(spy.calls.length).toBe(0)
    expect(err.join("")).toContain("SECRET")
  })

  test("DEFAULT-OFF: gate unset → exit 64, zero IO (byte-identity)", async () => {
    delete process.env[GATE]
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io, out, err } = makeIo()
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
    expect(out.length).toBe(0) // stdout pristine
    expect(spy.calls.length).toBe(0)
    expect(err.join("")).toContain("disabled")
  })

  test("DEFAULT-OFF: loose gate value 'on' is REFUSED (strict ===1)", async () => {
    process.env[GATE] = "on"
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io } = makeIo()
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
  })

  test("REPLAY GUARD: duplicate X-GitHub-Delivery → exactly ONE publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io)
    await waitUntil(() => bound.port() !== 0)

    const body = issueCommentPayload("@quanta dedup me")
    const headers = deliveryHeaders(body, "dup-1")
    const first = await postWebhook(bound.port(), body, headers)
    expect(first.status).toBe(202)
    expect(first.body).toBe("accepted")
    const second = await postWebhook(bound.port(), body, headers)
    expect(second.status).toBe(202)
    expect(second.body).toBe("duplicate delivery (dedup)")

    await waitUntil(() => spy.calls.length >= 1)
    // give a second pump cycle a chance to (wrongly) double-publish
    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(1)
  })

  test("oversized body → 413, no publish", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    const spy = makeSpyPublish()
    const { io } = makeIo()
    const host = runHost(bound, spy.fn, io)
    await waitUntil(() => bound.port() !== 0)

    // 10MB + 1 byte > MAX_REQUEST_BYTES → 413 before HMAC
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.fill(0x7b) // '{' bytes — irrelevant, rejected on size
    const res = await postWebhook(bound.port(), big, deliveryHeaders(big, "big-1"))
    expect(res.status).toBe(413)

    await new Promise<void>((r) => setTimeout(r, 30))
    host.stop()
    await host.done
    expect(spy.calls.length).toBe(0)
  })

  test("--help short-circuits before gate (no secret, exit 0, usage on stdout)", async () => {
    delete process.env[GATE]
    delete process.env[SECRET_ENV]
    const spy = makeSpyPublish()
    const { io, out } = makeIo()
    const code = await runWebhookServerCmd(["--help"], {
      io,
      deps: { publish: spy.fn, buildTransport: () => bound.transport },
    })
    expect(code).toBe(0)
    expect(out.join("")).toContain("quanta webhook")
    expect(bound.port()).toBe(0)
  })

  // B2 (audit) — a publish that NEVER settles must not wedge the pump: the
  // bounded publish-timeout logs + continues so a SUBSEQUENT trigger still
  // lands. RED-on-injection: remove the timeout race ⇒ the hung publish blocks
  // the loop forever and the 2nd event never publishes (test times out / fails).
  test("PUMP LIVENESS: a hung publish times out and the next trigger still publishes", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    const landed: string[] = []
    let n = 0
    const flaky: PublishReactorWatchTriggerFn = (opts) => {
      n += 1
      if (n === 1) return new Promise<void>(() => {}) // never settles (hang)
      landed.push(opts.trigger.evidence.value)
    }
    const { io } = makeIo()
    const host = runHost(bound, flaky, io, "live-session", { publishTimeoutMs: 40 })
    await waitUntil(() => bound.port() !== 0)
    const b1 = issueCommentPayload("@quanta first")
    await postWebhook(bound.port(), b1, deliveryHeaders(b1, "live-1"))
    const b2 = issueCommentPayload("@quanta second")
    await postWebhook(bound.port(), b2, deliveryHeaders(b2, "live-2"))
    // the 2nd publish must land despite the 1st hanging (pump not wedged)
    await waitUntil(() => landed.length >= 1, 4000)
    host.stop()
    const code = await host.done
    expect(code).toBe(0)
    expect(landed.length).toBe(1) // exactly the 2nd; the 1st timed out + dropped
  })

  // B1 (audit) — durable delivery dedup MUST survive a host restart: a GitHub
  // re-delivery (same X-GitHub-Delivery) after reboot is recognised and the
  // trigger is NOT re-fired. RED-on-injection: swap the durable store for the
  // ephemeral one ⇒ the 2nd run re-publishes (dedup state lost on restart).
  test("DURABLE DEDUP across restart: re-delivered id after reboot is NOT re-fired", async () => {
    process.env[GATE] = "1"
    process.env[SECRET_ENV] = SECRET
    // Drive the PRODUCTION DEFAULT store (no buildDeliveryStore injection) via an
    // isolated QUANTA_CONFIG_DIR — so this also LOCKS that production picks the
    // DURABLE flavour. RED-on-injection: revert the prod default to
    // createDeliveryStore() ⇒ run 2 re-fires ⇒ this test fails.
    const dir = mkdtempSync(join(tmpdir(), "wh-dedup-"))
    const savedCfgDir = process.env.QUANTA_CONFIG_DIR
    process.env.QUANTA_CONFIG_DIR = dir
    const body = issueCommentPayload("@quanta review")
    const headers = deliveryHeaders(body, "redeliver-1")
    try {
      // RUN 1 — fresh listener (a real boot), accept the delivery, publish once,
      // flush durable state to disk (production default durable store).
      const b1t = makeLoopbackTransport()
      const spy1 = makeSpyPublish()
      const io1 = makeIo()
      const h1 = runHost(b1t, spy1.fn, io1.io, "dd-session", { buildDeliveryStore: undefined })
      await waitUntil(() => b1t.port() !== 0)
      const r1 = await postWebhook(b1t.port(), body, headers)
      expect(r1.status).toBe(202)
      await waitUntil(() => spy1.calls.length >= 1)
      h1.stop()
      await h1.done
      expect(spy1.calls.length).toBe(1)

      // RUN 2 — fresh listener (simulated RESTART), SAME config dir. The SAME
      // delivery id must be recognised as already-seen ⇒ NO new publish.
      const b2t = makeLoopbackTransport()
      const spy2 = makeSpyPublish()
      const io2 = makeIo()
      const h2 = runHost(b2t, spy2.fn, io2.io, "dd-session", { buildDeliveryStore: undefined })
      await waitUntil(() => b2t.port() !== 0)
      const r2 = await postWebhook(b2t.port(), body, headers)
      // dedup short-circuits at the slice → 202 "duplicate", and crucially no publish
      expect(r2.status).toBe(202)
      await new Promise<void>((r) => setTimeout(r, 60))
      h2.stop()
      await h2.done
      expect(spy2.calls.length).toBe(0) // the teeth: restart did NOT re-fire
    } finally {
      if (savedCfgDir === undefined) delete process.env.QUANTA_CONFIG_DIR
      else process.env.QUANTA_CONFIG_DIR = savedCfgDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
