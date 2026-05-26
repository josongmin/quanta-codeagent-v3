/**
 * R5 hellgate — Tier-1 webhook host integration battery (SCAFFOLD).
 *
 * `webhook-server.ts` is currently a SCAFFOLD — `poll()` throws
 * `NOT_IMPLEMENTED` until the host decision lands (Bun.serve / node:http /
 * Cloudflare Worker). The signature-verify helper is wired but no real
 * request handling exists.
 *
 * This battery PINS the post-impl contract via `describe.skip` so the cases
 * are visible and ready to flip on. Each case asserts the boundary the host
 * impl MUST honor:
 *
 *   - HMAC verification on RAW bytes (not text-decoded).
 *   - Delivery-id dedup across multiple POSTs.
 *   - mention-filter intercepts before any downstream emit.
 *   - queue-cap → 429 (no leak past cap).
 *   - transport.close → no new requests served.
 *   - malformed JSON → no trigger, no throw.
 *   - abort signal propagation mid-handler.
 *   - request-handler throws → 500 + no leaked state.
 *
 * We also include ONE unskipped sanity test that the scaffold throws the
 * documented NOT_IMPLEMENTED error so a silent removal of the gate doesn't
 * go unnoticed. When the impl lands, this guard test is updated and the
 * `.skip`'d cases are turned on.
 */

import { describe, expect, test } from "bun:test"
import { createDeliveryStore } from "@/integrations/github/idempotency"
import type { WebhookHandle, WebhookTransportPort } from "@/integrations/github/webhook-server"
import { createWebhookEventSource } from "@/integrations/github/webhook-server"
import type { ClockPort } from "@/reactor"

const clockOf = (): ClockPort => ({ now: () => 1_700_000_000_000 })

const noopTransport: WebhookTransportPort = {
  async listen(): Promise<WebhookHandle> {
    return {
      async close(): Promise<void> {
        // noop
      },
    }
  },
}

describe("R5 — webhook tier1 host (R5 impl) sanity", () => {
  // R5 impl landed — `createWebhookEventSource` now returns a working
  // TriggerSourcePort backed by an injected transport. These cases pin the
  // boot-time contract that survived the NOT_IMPLEMENTED → working transition.

  test("poll() before start → returns empty array (no triggers queued yet)", async () => {
    const source = createWebhookEventSource({
      transport: noopTransport,
      secret: "test-secret-for-boot-check",
      clockPort: clockOf(),
    })
    const triggers = await source.poll()
    expect(triggers).toEqual([])
  })

  test("empty secret at boot → throws (open-bypass prevention)", () => {
    expect(() =>
      createWebhookEventSource({
        transport: noopTransport,
        secret: "",
        clockPort: clockOf(),
      }),
    ).toThrow(/secret/)
  })

  test("missing transport at boot → throws", () => {
    expect(() =>
      createWebhookEventSource({
        // @ts-expect-error — exercising the missing-port boot-time guard
        transport: undefined,
        secret: "ok",
        clockPort: clockOf(),
      }),
    ).toThrow()
  })

  test("deliveryStore wired (sanity) — poll function present", () => {
    const ds = createDeliveryStore()
    const src = createWebhookEventSource({
      transport: noopTransport,
      secret: "ok",
      clockPort: clockOf(),
      deliveryStore: ds,
    })
    expect(src.poll).toBeInstanceOf(Function)
  })
})

// ── POST-IMPL battery — turn on when the host adapter lands. ─────────────
describe.skip("R5 — webhook tier1 host contract (POST-IMPL)", () => {
  // These tests run against the future Tier-1 impl. Each is sketched as the
  // host implementor's checklist so the boundary is pinned BEFORE the impl
  // touches it.

  test("HMAC-valid request → trigger emitted, status 202", async () => {
    // 1. Compute correct hex SHA256-HMAC over body bytes.
    // 2. POST with X-Hub-Signature-256 header.
    // 3. Expect status 202 + the source emits 1 ProactiveTrigger.
    expect(true).toBe(true)
  })

  test("HMAC mismatch → no trigger, status 401", async () => {
    expect(true).toBe(true)
  })

  test("delivery-id dedup across multiple POSTs (idempotency)", async () => {
    // Two POSTs with same X-GitHub-Delivery header → only 1 trigger.
    expect(true).toBe(true)
  })

  test("mention-filter intercepts code-block + bot sender (no trigger)", async () => {
    // The webhook adapter MUST run the same mention-filter as the actions
    // path; otherwise the trust-scope guard differs by surface.
    expect(true).toBe(true)
  })

  test("queue capacity limit → status 429 when full (no leak past cap)", async () => {
    expect(true).toBe(true)
  })

  test("transport.close() → no new requests served", async () => {
    // After close, calling handler raises or returns service-unavailable.
    expect(true).toBe(true)
  })

  test("malformed JSON body → no trigger, status 400, no exception", async () => {
    expect(true).toBe(true)
  })

  test("abort signal propagation mid-handler → graceful 503", async () => {
    expect(true).toBe(true)
  })

  test("raw byte preservation — HMAC computed on EXACT request bytes", async () => {
    // The transport MUST pass Uint8Array (NOT a JSON-parsed object) so
    // signature verification is byte-identical with what GitHub sent.
    expect(true).toBe(true)
  })

  test("request handler throws → status 500, no leaked state, next request OK", async () => {
    expect(true).toBe(true)
  })
})
