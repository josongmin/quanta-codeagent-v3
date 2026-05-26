/**
 * ADR-0312 — Bun + node:http transport happy paths.
 *
 * Boots each adapter on an ephemeral port (`0`), does a real fetch against
 * `/webhook`, and asserts the captured request shape (raw bytes, header map,
 * method, path). The webhook-server's signature path is NOT exercised here —
 * that's the responsibility of `webhook-server.test.ts`. This file proves the
 * TRANSPORT contract: bytes in, response out.
 */

import { describe, expect, test } from "bun:test"

import {
  createBunWebhookTransport,
  createNodeWebhookTransport,
  type WebhookHandle,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransportPort,
} from "@/integrations/github"

interface CapturedReq {
  req: WebhookRequest
  resolvedResponse: WebhookResponse
}

const harness = async (
  transport: WebhookTransportPort,
  body: string | Uint8Array,
  init: { method?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ resp: Response; captured: CapturedReq | undefined; handle: WebhookHandle }> => {
  let captured: CapturedReq | undefined
  const handle = await transport.listen({
    async onRequest(req) {
      const r: WebhookResponse = { status: 202, body: "ok-test" }
      captured = { req, resolvedResponse: r }
      return r
    },
  })
  try {
    const port = await ephemeralPortHint(transport)
    const url = `http://127.0.0.1:${port}${init.path ?? "/webhook"}`
    const resp = await fetch(url, {
      method: init.method ?? "POST",
      headers: init.headers ?? { "content-type": "application/json" },
      body,
    })
    // Drain body so the underlying connection can close cleanly.
    await resp.text()
    return { resp, captured, handle }
  } catch (err) {
    await handle.close()
    throw err
  }
}

/** Most production transports record the bound port off `Bun.serve` / `node:http`.
 *  Our `WebhookTransportPort` doesn't expose it, so test code uses fixed test ports
 *  via env. To keep this self-contained we accept the implicit guarantee that the
 *  factory accepts a number and binds to it. We use a hard-coded high port. */
let nextPort = 47210
const allocatePort = (): number => {
  nextPort += 1
  return nextPort
}

const ephemeralPortHint = async (_t: WebhookTransportPort): Promise<number> => {
  // Tests bind each transport to a fresh allocator-issued port; the port is
  // baked into the test by the factory builder below.
  return CURRENT_PORT
}

let CURRENT_PORT = 0

describe("ADR-0312 — Bun webhook transport", () => {
  test("POST /webhook reaches onRequest with raw bytes + headers", async () => {
    CURRENT_PORT = allocatePort()
    const t = createBunWebhookTransport({ port: CURRENT_PORT, hostname: "127.0.0.1" })
    const body = '{"hello":"world"}'
    const out = await harness(t, body, {
      headers: { "content-type": "application/json", "x-custom": "yes" },
    })
    expect(out.resp.status).toBe(202)
    expect(out.captured).toBeDefined()
    if (out.captured === undefined) throw new Error("unreachable")
    expect(out.captured.req.method).toBe("POST")
    expect(out.captured.req.path).toBe("/webhook")
    expect(new TextDecoder().decode(out.captured.req.body)).toBe(body)
    expect(out.captured.req.headers["x-custom"]).toBe("yes")
    await out.handle.close()
  })

  test("404 path is delivered to onRequest as a non-/webhook path", async () => {
    CURRENT_PORT = allocatePort()
    const t = createBunWebhookTransport({ port: CURRENT_PORT, hostname: "127.0.0.1" })
    const out = await harness(t, "x", { path: "/other" })
    expect(out.captured?.req.path).toBe("/other")
    await out.handle.close()
  })

  test("close() stops the listener (subsequent fetch fails)", async () => {
    CURRENT_PORT = allocatePort()
    const t = createBunWebhookTransport({ port: CURRENT_PORT, hostname: "127.0.0.1" })
    const out = await harness(t, "y")
    await out.handle.close()
    // After close, a fetch to the same port should fail to connect.
    let failed = false
    try {
      await fetch(`http://127.0.0.1:${CURRENT_PORT}/webhook`, { method: "POST", body: "z" })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})

describe("ADR-0312 — node:http webhook transport", () => {
  test("POST /webhook reaches onRequest with raw bytes + headers", async () => {
    CURRENT_PORT = allocatePort()
    const t = createNodeWebhookTransport({ port: CURRENT_PORT, hostname: "127.0.0.1" })
    const body = '{"a":1}'
    const out = await harness(t, body, {
      headers: { "content-type": "application/json", "x-custom": "node-yes" },
    })
    expect(out.resp.status).toBe(202)
    expect(out.captured).toBeDefined()
    if (out.captured === undefined) throw new Error("unreachable")
    expect(out.captured.req.method).toBe("POST")
    expect(out.captured.req.path).toBe("/webhook")
    expect(new TextDecoder().decode(out.captured.req.body)).toBe(body)
    expect(out.captured.req.headers["x-custom"]).toBe("node-yes")
    await out.handle.close()
  })

  test("query string is stripped from path", async () => {
    CURRENT_PORT = allocatePort()
    const t = createNodeWebhookTransport({ port: CURRENT_PORT, hostname: "127.0.0.1" })
    const out = await harness(t, "x", { path: "/webhook?ignored=1" })
    expect(out.captured?.req.path).toBe("/webhook")
    await out.handle.close()
  })

  test("close() stops the listener", async () => {
    CURRENT_PORT = allocatePort()
    const t = createNodeWebhookTransport({ port: CURRENT_PORT, hostname: "127.0.0.1" })
    const out = await harness(t, "ok")
    await out.handle.close()
    let failed = false
    try {
      await fetch(`http://127.0.0.1:${CURRENT_PORT}/webhook`, { method: "POST", body: "x" })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
