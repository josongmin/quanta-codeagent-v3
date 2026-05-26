/**
 * ADR-0312 — webhook-server live impl: happy paths + boundary contracts.
 *
 * Drives the source through an IN-MEMORY transport stub so the assertions
 * are deterministic and free of real network IO. Each test calls
 * `transport.deliver(req)` (a helper attached to the stub) which routes
 * through `onRequest` exactly as a real transport would.
 */

import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import {
  createDeliveryStore,
  createWebhookEventSource,
  type WebhookHandle,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransportPort,
} from "@/integrations/github"

import { fixedClock } from "./_helpers"

const SECRET = "shh-secret"

interface StubTransport extends WebhookTransportPort {
  deliver(req: WebhookRequest): Promise<WebhookResponse>
  closed(): boolean
  listenCalls(): number
}

const makeStubTransport = (): StubTransport => {
  let handler: ((req: WebhookRequest) => Promise<WebhookResponse>) | undefined
  let isClosed = false
  let listenN = 0
  return {
    async listen({ onRequest }) {
      listenN += 1
      handler = onRequest
      const handle: WebhookHandle = {
        async close() {
          isClosed = true
        },
      }
      return handle
    },
    async deliver(req) {
      if (handler === undefined) throw new Error("stub transport: not listening")
      return handler(req)
    },
    closed: () => isClosed,
    listenCalls: () => listenN,
  }
}

const sign = (body: Uint8Array, secret: string = SECRET): string => {
  const h = createHmac("sha256", secret).update(body).digest("hex")
  return `sha256=${h}`
}

const validEvent = (): Uint8Array => {
  const json = JSON.stringify({
    action: "created",
    repository: { owner: { login: "octo" }, name: "demo" },
    sender: { login: "alice", type: "User" },
    issue: { number: 7, pull_request: {} },
    comment: { body: "@quanta please review", author_association: "COLLABORATOR" },
  })
  return new TextEncoder().encode(json)
}

const makeReq = (body: Uint8Array, headers: Record<string, string> = {}): WebhookRequest => ({
  method: "POST",
  path: "/webhook",
  body,
  headers: {
    "x-github-event": "issue_comment",
    "x-github-delivery": `deliv-${Math.random().toString(36).slice(2)}`,
    "x-hub-signature-256": sign(body),
    "content-type": "application/json",
    ...headers,
  },
})

describe("ADR-0312 — createWebhookEventSource live impl", () => {
  test("empty secret ⇒ boot throws (no open bypass)", () => {
    const t = makeStubTransport()
    expect(() =>
      createWebhookEventSource({
        transport: t,
        secret: "",
        clockPort: fixedClock(0),
      }),
    ).toThrow(/non-empty string/)
  })

  test("missing transport ⇒ boot throws", () => {
    expect(() =>
      createWebhookEventSource({
        // biome-ignore lint/suspicious/noExplicitAny: deliberate undef
        transport: undefined as any,
        secret: SECRET,
        clockPort: fixedClock(0),
      }),
    ).toThrow(/transport port required/)
  })

  test("happy: valid sig + collaborator mention ⇒ 202 + queue size +1", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = validEvent()
    const resp = await t.deliver(makeReq(body))
    expect(resp.status).toBe(202)
    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
    const tr = triggers[0]
    if (tr === undefined) throw new Error("unreachable")
    expect(tr.reason).toBe("pr_comment")
    expect(tr.evidence.value).toBe("https://github.com/octo/demo/pull/7")
    expect(tr.simulatedMessage).toContain("@alice")
    await src.stop()
  })

  test("invalid signature ⇒ 401 + queue unchanged", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = validEvent()
    const req = makeReq(body, { "x-hub-signature-256": "sha256=deadbeef" })
    const resp = await t.deliver(req)
    expect(resp.status).toBe(401)
    expect((await src.poll()).length).toBe(0)
  })

  test("missing signature header ⇒ 401", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = validEvent()
    // Build req sans x-hub-signature-256 by omitting it explicitly.
    const headers = {
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    }
    const resp = await t.deliver({ method: "POST", path: "/webhook", body, headers })
    expect(resp.status).toBe(401)
  })

  test("bot sender ⇒ 202 + queue 0 (filtered)", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "created",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "bot[bot]", type: "Bot" },
        issue: { number: 1, pull_request: {} },
        comment: { body: "@quanta hi", author_association: "COLLABORATOR" },
      }),
    )
    const resp = await t.deliver(makeReq(body))
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(0)
  })

  test("non-collaborator ⇒ 202 + queue 0", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "created",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "stranger", type: "User" },
        issue: { number: 1, pull_request: {} },
        comment: { body: "@quanta hi", author_association: "NONE" },
      }),
    )
    const resp = await t.deliver(makeReq(body))
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(0)
  })

  test("duplicate delivery id ⇒ 202 + queue still has only first one", async () => {
    const t = makeStubTransport()
    const store = createDeliveryStore()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
      deliveryStore: store,
    })
    await src.start()
    const body = validEvent()
    const req1 = makeReq(body, { "x-github-delivery": "dup-1" })
    const req2 = makeReq(body, { "x-github-delivery": "dup-1" })
    expect((await t.deliver(req1)).status).toBe(202)
    expect((await t.deliver(req2)).status).toBe(202)
    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
  })

  test("queue full ⇒ 503", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
      queueCapacity: 2,
    })
    await src.start()
    // Three distinct delivery ids, all valid mentions.
    const body = validEvent()
    const r1 = await t.deliver(makeReq(body, { "x-github-delivery": "q-1" }))
    const r2 = await t.deliver(makeReq(body, { "x-github-delivery": "q-2" }))
    const r3 = await t.deliver(makeReq(body, { "x-github-delivery": "q-3" }))
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    expect(r3.status).toBe(503)
  })

  test("poll() drains the queue (subsequent poll returns empty)", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = validEvent()
    await t.deliver(makeReq(body, { "x-github-delivery": "drain-1" }))
    await t.deliver(makeReq(body, { "x-github-delivery": "drain-2" }))
    const first = await src.poll()
    expect(first.length).toBe(2)
    const second = await src.poll()
    expect(second.length).toBe(0)
  })

  test("stop() calls transport.close()", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    expect(t.closed()).toBe(false)
    await src.stop()
    expect(t.closed()).toBe(true)
  })

  test("mention inside code block ⇒ queue 0 (mention-filter ignores fenced)", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "created",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "alice", type: "User" },
        issue: { number: 1, pull_request: {} },
        comment: {
          body: "```\n@quanta look\n```",
          author_association: "COLLABORATOR",
        },
      }),
    )
    const resp = await t.deliver(makeReq(body))
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(0)
  })

  test("large but in-cap payload ⇒ still OK", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    // ~64KB padded body with a valid event shape.
    const padding = "x".repeat(64 * 1024)
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "created",
        repository: { owner: { login: "octo" }, name: "demo" },
        sender: { login: "alice", type: "User" },
        issue: { number: 99, pull_request: {} },
        comment: {
          body: `@quanta hello ${padding}`,
          author_association: "COLLABORATOR",
        },
      }),
    )
    const resp = await t.deliver(makeReq(body, { "x-github-delivery": "big-1" }))
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(1)
  })

  test("workflow_dispatch bypasses mention-filter ⇒ trigger emitted", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "requested",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "u", type: "User" },
        inputs: { foo: "bar" },
      }),
    )
    const resp = await t.deliver(
      makeReq(body, {
        "x-github-event": "workflow_dispatch",
        "x-github-delivery": "wd-1",
        "x-hub-signature-256": sign(body),
      }),
    )
    expect(resp.status).toBe(202)
    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
    expect(triggers[0]?.reason).toBe("manual_resume")
  })

  test("start() is idempotent", async () => {
    const t = makeStubTransport()
    const src = createWebhookEventSource({
      transport: t,
      secret: SECRET,
      clockPort: fixedClock(0),
    })
    await src.start()
    await src.start()
    expect(t.listenCalls()).toBe(1)
    await src.stop()
  })
})
