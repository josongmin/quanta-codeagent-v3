/**
 * ADR-0312 hellgate R5 — adversarial inputs against the webhook event source.
 *
 * Covers attack surfaces the unit happy-path tests don't:
 *   - timing-safe sig path (length-extension immune via SHA-256),
 *   - single-bit secret flips,
 *   - malformed signature header shapes,
 *   - oversize body / oversize headers,
 *   - replay (delivery-id dedup),
 *   - queue overflow under burst,
 *   - bad HTTP shape (wrong method / wrong path),
 *   - malformed / empty JSON body,
 *   - start/stop race + double-stop.
 *
 * Every assertion is structural: no heuristics, no timing comparisons.
 */

import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import {
  createDeliveryStore,
  createWebhookEventSource,
  MAX_REQUEST_BYTES,
  type WebhookHandle,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransportPort,
} from "@/integrations/github"

import { fixedClock } from "./_helpers"

const SECRET = "shh-secret-r5"

interface StubTransport extends WebhookTransportPort {
  deliver(req: WebhookRequest): Promise<WebhookResponse>
  closed(): boolean
}

const makeStub = (): StubTransport => {
  let handler: ((req: WebhookRequest) => Promise<WebhookResponse>) | undefined
  let isClosed = false
  return {
    async listen({ onRequest }) {
      handler = onRequest
      const handle: WebhookHandle = {
        async close() {
          isClosed = true
        },
      }
      return handle
    },
    async deliver(req) {
      if (handler === undefined) throw new Error("not listening")
      return handler(req)
    },
    closed: () => isClosed,
  }
}

const sign = (body: Uint8Array, secret: string = SECRET): string => {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

const validBody = (): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      action: "created",
      repository: { owner: { login: "octo" }, name: "demo" },
      sender: { login: "alice", type: "User" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "@quanta look", author_association: "COLLABORATOR" },
    }),
  )

const makeReq = (
  body: Uint8Array,
  overrides: Partial<WebhookRequest> = {},
  hdrOverrides: Record<string, string | undefined> = {},
): WebhookRequest => {
  const base: Record<string, string> = {
    "x-github-event": "issue_comment",
    "x-github-delivery": `d-${Math.random().toString(36).slice(2, 10)}`,
    "x-hub-signature-256": sign(body),
    "content-type": "application/json",
  }
  for (const [k, v] of Object.entries(hdrOverrides)) {
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  return {
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/webhook",
    body: overrides.body ?? body,
    headers: overrides.headers ?? base,
  }
}

const boot = (extra: Partial<Parameters<typeof createWebhookEventSource>[0]> = {}) => {
  const t = makeStub()
  const src = createWebhookEventSource({
    transport: t,
    secret: SECRET,
    clockPort: fixedClock(0),
    ...extra,
  })
  return { t, src }
}

describe("ADR-0312 R5 — webhook server adversarial inputs", () => {
  test("length-extension attack attempt (forged padded sig) ⇒ 401", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const real = sign(body)
    // Append extra bytes — destroys length match. SHA-256 is also immune to
    // length-extension by construction (no Merkle-Damgård HMAC weakness), so
    // any forged extension fails timing-safe compare.
    const forged = `${real}aabb`
    const resp = await t.deliver(makeReq(body, {}, { "x-hub-signature-256": forged }))
    expect(resp.status).toBe(401)
    await src.stop()
  })

  test("secret mismatch by 1 byte ⇒ 401", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    // Sign with a different secret (single-char diff).
    const wrongSig = sign(body, "shh-secret-r4")
    const resp = await t.deliver(makeReq(body, {}, { "x-hub-signature-256": wrongSig }))
    expect(resp.status).toBe(401)
    await src.stop()
  })

  test("missing 'sha256=' prefix ⇒ 401", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const noPrefix = sign(body).slice("sha256=".length)
    const resp = await t.deliver(makeReq(body, {}, { "x-hub-signature-256": noPrefix }))
    expect(resp.status).toBe(401)
    await src.stop()
  })

  test("malformed hex characters in sig ⇒ 401", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const malformed = `sha256=${"z".repeat(64)}`
    const resp = await t.deliver(makeReq(body, {}, { "x-hub-signature-256": malformed }))
    expect(resp.status).toBe(401)
    await src.stop()
  })

  test("payload above MAX_REQUEST_BYTES ⇒ 413", async () => {
    const { t, src } = boot()
    await src.start()
    // Build a body just over the cap. Sign it so the only rejection signal
    // is the size guard (which must fire BEFORE HMAC compute in routing).
    const big = new Uint8Array(MAX_REQUEST_BYTES + 1)
    // Fill with 0x20 (space) so JSON.parse fails predictably even if we
    // somehow get past the size check.
    big.fill(0x20)
    const resp = await t.deliver(makeReq(big, {}, { "x-hub-signature-256": sign(big) }))
    expect(resp.status).toBe(413)
    await src.stop()
  })

  test("replay (same delivery id twice) ⇒ second is 202 + dedup, queue len 1", async () => {
    const store = createDeliveryStore()
    const { t, src } = boot({ deliveryStore: store })
    await src.start()
    const body = validBody()
    const id = "replay-id-9"
    const r1 = await t.deliver(makeReq(body, {}, { "x-github-delivery": id }))
    const r2 = await t.deliver(makeReq(body, {}, { "x-github-delivery": id }))
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
    await src.stop()
  })

  test("queue overflow under burst ⇒ first N accepted, remainder 503", async () => {
    const { t, src } = boot({ queueCapacity: 3 })
    await src.start()
    const body = validBody()
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      const r = await t.deliver(makeReq(body, {}, { "x-github-delivery": `burst-${i}` }))
      statuses.push(r.status)
    }
    const accepted = statuses.filter((s) => s === 202).length
    const rejected = statuses.filter((s) => s === 503).length
    expect(accepted).toBe(3)
    expect(rejected).toBe(7)
    await src.stop()
  })

  test("concurrent burst (100 distinct deliveries, cap 50) ⇒ exactly 50 accepted", async () => {
    const { t, src } = boot({ queueCapacity: 50 })
    await src.start()
    const body = validBody()
    const promises: Array<Promise<WebhookResponse>> = []
    for (let i = 0; i < 100; i++) {
      promises.push(t.deliver(makeReq(body, {}, { "x-github-delivery": `c-${i}` })))
    }
    const results = await Promise.all(promises)
    const a = results.filter((r) => r.status === 202).length
    const r = results.filter((r) => r.status === 503).length
    expect(a).toBe(50)
    expect(r).toBe(50)
    await src.stop()
  })

  test("GET /webhook ⇒ 405 method not allowed", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const resp = await t.deliver({
      method: "GET",
      path: "/webhook",
      body,
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": "g-1",
        "x-hub-signature-256": sign(body),
      },
    })
    expect(resp.status).toBe(405)
    await src.stop()
  })

  test("POST /other-path ⇒ 404 not found", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const resp = await t.deliver({
      method: "POST",
      path: "/other-path",
      body,
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": "o-1",
        "x-hub-signature-256": sign(body),
      },
    })
    expect(resp.status).toBe(404)
    await src.stop()
  })

  test("malformed JSON body ⇒ 400", async () => {
    const { t, src } = boot()
    await src.start()
    const body = new TextEncoder().encode("{not-json:")
    const resp = await t.deliver(
      makeReq(body, {}, { "x-hub-signature-256": sign(body), "x-github-delivery": "m-1" }),
    )
    expect(resp.status).toBe(400)
    await src.stop()
  })

  test("empty body ⇒ 400", async () => {
    const { t, src } = boot()
    await src.start()
    const body = new Uint8Array(0)
    const resp = await t.deliver(
      makeReq(body, {}, { "x-hub-signature-256": sign(body), "x-github-delivery": "e-1" }),
    )
    expect(resp.status).toBe(400)
    await src.stop()
  })

  test("extremely long header value ⇒ 431", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const huge = "a".repeat(16 * 1024) // > 8KB cap
    const resp = await t.deliver(makeReq(body, {}, { "x-huge-attack-header": huge }))
    expect(resp.status).toBe(431)
    await src.stop()
  })

  test("missing X-GitHub-Delivery ⇒ 400", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const resp = await t.deliver(makeReq(body, {}, { "x-github-delivery": undefined }))
    expect(resp.status).toBe(400)
    await src.stop()
  })

  test("unknown event kind ⇒ 202 ignored (no enqueue)", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    const resp = await t.deliver(
      makeReq(
        body,
        {},
        {
          "x-github-event": "fork", // not in our allowlist
          "x-github-delivery": "u-1",
          "x-hub-signature-256": sign(body),
        },
      ),
    )
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(0)
    await src.stop()
  })

  test("self-loop marker in body ⇒ filtered out (queue 0)", async () => {
    const { t, src } = boot()
    await src.start()
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "created",
        repository: { owner: { login: "octo" }, name: "demo" },
        sender: { login: "alice", type: "User" },
        issue: { number: 7, pull_request: {} },
        comment: {
          body: "@quanta hi <!-- quanta:idempotency=abcdef -->",
          author_association: "COLLABORATOR",
        },
      }),
    )
    const resp = await t.deliver(makeReq(body))
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(0)
    await src.stop()
  })

  test("start/stop race: double-stop is safe", async () => {
    const { t, src } = boot()
    await src.start()
    await src.stop()
    await src.stop() // second stop must not throw
    expect(t.closed()).toBe(true)
  })

  test("stop without start is safe (no-op)", async () => {
    const { t: _t, src } = boot()
    await src.stop()
    // No throw, no listener was opened — just verify shape.
    expect(true).toBe(true)
  })

  test("case-insensitive header lookup (X-Hub-Signature-256 vs x-hub-signature-256)", async () => {
    const { t, src } = boot()
    await src.start()
    const body = validBody()
    // Mixed-case header keys — our transport adapters normalize to lower, but
    // routeRequest also accepts mixed-case to be defensive.
    const resp = await t.deliver({
      method: "POST",
      path: "/webhook",
      body,
      headers: {
        "X-GitHub-Event": "issue_comment",
        "X-GitHub-Delivery": "case-1",
        "X-Hub-Signature-256": sign(body),
      },
    })
    expect(resp.status).toBe(202)
    expect((await src.poll()).length).toBe(1)
    await src.stop()
  })

  test("onError callback fires on queue overflow (audit hook)", async () => {
    const errors: string[] = []
    const { t, src } = boot({ queueCapacity: 1, onError: (m) => errors.push(m) })
    await src.start()
    const body = validBody()
    await t.deliver(makeReq(body, {}, { "x-github-delivery": "err-1" }))
    await t.deliver(makeReq(body, {}, { "x-github-delivery": "err-2" }))
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("queue full")
    await src.stop()
  })
})
