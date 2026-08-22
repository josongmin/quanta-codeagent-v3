/**
 * FULL INBOUND CHAIN e2e (ADR-0312 + reactor-watch IPC) — the seam the
 * host-cli hellgate spy-mocks.
 *
 * github-webhook-host-cli-hellgate proves the host PUMP with a SPY publish;
 * reactor-watch-cli-bridge proves the IPC bridge in isolation. NEITHER connects
 * them. THIS test drives the real cross-process seam end-to-end:
 *
 *   signed PR-comment POST → Bun/node webhook host → host poll→publish PUMP →
 *   the REAL publishReactorWatchTrigger over a REAL unix socket →
 *   startReactorWatchBridge consumer → onTrigger fires with the review trigger.
 *
 * Hermetic: loopback HTTP transport on an ephemeral port + a tmp unix socket.
 * No spy on publish — the host uses the real IPC publisher (pinned to the tmp
 * socket via deps.publish), so a break anywhere in the chain (sign verify,
 * normalize, pump drain, IPC encode, socket framing, consumer decode) fails it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  publishReactorWatchTrigger,
  startReactorWatchBridge,
} from "@/apps/cli/reactor-watch-bridge"
import { runWebhookServerCmd, type WebhookServerCmdDeps } from "@/apps/cli/webhook-server-setup"
import {
  createDeliveryStore,
  type WebhookHandle,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransportPort,
} from "@/integrations/github"
import type { ProactiveTrigger } from "@/reactor"

const SECRET = "reactor-e2e-secret"
const GATE = "QUANTA_GITHUB_WEBHOOK"
const SECRET_ENV = "QUANTA_GITHUB_WEBHOOK_SECRET"

// ── loopback http transport (ephemeral port) ───────────────────────────────
interface Bound {
  readonly transport: WebhookTransportPort
  port(): number
}
const loopback = (): Bound => {
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
              out = { status: 500, body: "threw" }
            }
            res.writeHead(out.status, { "content-type": "text/plain" })
            res.end(out.body ?? "")
          })()
        })
      })
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()))
      boundPort = (server?.address() as AddressInfo).port
      const handle: WebhookHandle = {
        async close() {
          await new Promise<void>((resolve) => server?.close(() => resolve()))
        },
      }
      return handle
    },
  }
  return { transport, port: () => boundPort }
}

const signBody = (body: Uint8Array): string =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`

const prComment = (text: string): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      JSON.stringify({
        action: "created",
        repository: { owner: { login: "octo" }, name: "widget" },
        sender: { login: "alice", type: "User" },
        issue: { number: 42, pull_request: { url: "https://api.github.com/x/pulls/42" }, body: "" },
        comment: {
          body: text,
          author_association: "COLLABORATOR",
          user: { login: "alice" },
        },
      }),
      "utf8",
    ),
  )

const post = (port: number, body: Uint8Array, headers: Record<string, string>): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/webhook",
        headers: { "content-length": String(body.length), ...headers },
      },
      (res) => {
        res.on("data", () => {})
        res.on("end", () => resolve(res.statusCode ?? 0))
      },
    )
    req.on("error", reject)
    req.write(body)
    req.end()
  })

const waitUntil = async (pred: () => boolean, timeoutMs = 4000): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

let savedGate: string | undefined
let savedSecret: string | undefined
let dir: string
beforeEach(() => {
  savedGate = process.env[GATE]
  savedSecret = process.env[SECRET_ENV]
  process.env[GATE] = "1"
  process.env[SECRET_ENV] = SECRET
  dir = mkdtempSync(join(tmpdir(), "wh-reactor-"))
})
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]
  else process.env[GATE] = savedGate
  if (savedSecret === undefined) delete process.env[SECRET_ENV]
  else process.env[SECRET_ENV] = savedSecret
  rmSync(dir, { recursive: true, force: true })
})

describe("FULL inbound chain: webhook → host pump → REAL IPC → reactor consumer", () => {
  test("a signed @quanta PR comment reaches the reactor consumer as a pr_comment trigger", async () => {
    const socketPath = join(dir, "reactor-e2e.sock")
    // The REAL reactor-watch consumer (a live unix-socket server).
    const received: ProactiveTrigger[] = []
    const bridge = await startReactorWatchBridge({
      sessionId: "e2e-session",
      socketPath,
      onTrigger: (t) => {
        received.push(t)
      },
    })

    const bound = loopback()
    // The host uses the REAL IPC publisher (no spy), pinned to our tmp socket.
    const deps: WebhookServerCmdDeps = {
      buildTransport: () => bound.transport,
      pollIntervalMs: 5,
      buildDeliveryStore: () => createDeliveryStore(),
      publish: (opts) =>
        publishReactorWatchTrigger({
          sessionId: opts.sessionId,
          trigger: opts.trigger,
          socketPath,
        }),
    }
    const prev = process.env.QUANTA_GITHUB_WEBHOOK_SESSION
    process.env.QUANTA_GITHUB_WEBHOOK_SESSION = "e2e-session"
    const done = runWebhookServerCmd([], {
      io: { out: () => {}, err: () => {} },
      deps,
    }).finally(() => {
      if (prev === undefined) delete process.env.QUANTA_GITHUB_WEBHOOK_SESSION
      else process.env.QUANTA_GITHUB_WEBHOOK_SESSION = prev
    })

    try {
      await waitUntil(() => bound.port() !== 0)
      const body = prComment("@quanta please review this PR")
      const status = await post(body.length === 0 ? 0 : bound.port(), body, {
        "x-github-event": "issue_comment",
        "x-github-delivery": "e2e-1",
        "content-type": "application/json",
        "x-hub-signature-256": signBody(body),
      })
      expect(status).toBe(202)

      // The trigger crossed the REAL unix socket into the consumer.
      await waitUntil(() => received.length >= 1)
      expect(received.length).toBe(1)
      const t = received[0]
      expect(t?.reason).toBe("pr_comment")
      expect(t?.evidence.kind).toBe("url")
      expect(t?.evidence.value).toContain("widget/pull/42")
      // The simulated turn the agent will run carries the review intent.
      expect(typeof t?.simulatedMessage).toBe("string")
      expect((t?.simulatedMessage ?? "").length).toBeGreaterThan(0)
    } finally {
      process.emit("SIGINT")
      await done
      await bridge.close()
    }
  })

  test("a FORGED signature never reaches the reactor consumer (security, full chain)", async () => {
    const socketPath = join(dir, "reactor-forged.sock")
    const received: ProactiveTrigger[] = []
    const bridge = await startReactorWatchBridge({
      sessionId: "e2e-session",
      socketPath,
      onTrigger: (t) => {
        received.push(t)
      },
    })
    const bound = loopback()
    const deps: WebhookServerCmdDeps = {
      buildTransport: () => bound.transport,
      pollIntervalMs: 5,
      buildDeliveryStore: () => createDeliveryStore(),
      publish: (opts) =>
        publishReactorWatchTrigger({
          sessionId: opts.sessionId,
          trigger: opts.trigger,
          socketPath,
        }),
    }
    const prev = process.env.QUANTA_GITHUB_WEBHOOK_SESSION
    process.env.QUANTA_GITHUB_WEBHOOK_SESSION = "e2e-session"
    const done = runWebhookServerCmd([], { io: { out: () => {}, err: () => {} }, deps }).finally(
      () => {
        if (prev === undefined) delete process.env.QUANTA_GITHUB_WEBHOOK_SESSION
        else process.env.QUANTA_GITHUB_WEBHOOK_SESSION = prev
      },
    )
    try {
      await waitUntil(() => bound.port() !== 0)
      const body = prComment("@quanta review")
      const status = await post(bound.port(), body, {
        "x-github-event": "issue_comment",
        "x-github-delivery": "forged-1",
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef", // forged
      })
      expect(status).toBe(401)
      await new Promise<void>((r) => setTimeout(r, 80))
      expect(received.length).toBe(0) // nothing crossed the socket
    } finally {
      process.emit("SIGINT")
      await done
      await bridge.close()
    }
  })
})
