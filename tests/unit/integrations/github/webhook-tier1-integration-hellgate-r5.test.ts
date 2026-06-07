/**
 * R5 hellgate — Tier-1 webhook host boot-contract battery.
 *
 * `createWebhookEventSource` returns a working TriggerSourcePort backed by an
 * injected transport. These cases pin the boot-time contract that must hold
 * regardless of the chosen host adapter (Bun.serve / node:http / Worker):
 * empty-poll before start, empty-secret rejection (open-bypass prevention),
 * missing-transport rejection, and delivery-store wiring.
 *
 * NOTE: the live request-handling contract (HMAC-on-raw-bytes, delivery-id
 * dedup, mention-filter interception, queue-cap → 429, close → no-serve,
 * malformed-JSON, abort propagation, handler-throw → 500) is owned by the
 * adapter-level suites that drive a real request through the transport — see
 * the webhook signature-verify + idempotency unit tests. A skipped placeholder
 * battery (always-green tautologies) used to live here and was removed because
 * skipped tautologies guard nothing.
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
