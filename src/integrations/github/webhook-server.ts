/**
 * ADR-0312 — Tier-1 webhook server SCAFFOLD.
 *
 * Ports + factory shape are in place; the in-process implementation is
 * intentionally `NOT_IMPLEMENTED` until the host decision (Cloudflare Worker
 * vs Vercel function vs in-process HTTP) lands. The signature-verify helper
 * is already wired so the unit-test surface can prove the HMAC contract
 * independent of the transport.
 *
 * What the host will need to plug in (composition root):
 *   - {@link WebhookTransportPort.listen} that yields raw bodies + headers
 *     so signature verification runs on the ACTUAL bytes,
 *   - a queue contract (out of scope here) so the trigger source can drain
 *     deliveries off the hot HTTP path,
 *   - the same `DeliveryStore` from `idempotency.ts` to dedup retries.
 */

import type { ClockPort, EnvPort, ProactiveTrigger, TriggerSourcePort } from "@/reactor"

import type { DeliveryStore } from "./idempotency"
import { verifyHubSignature256 } from "./signature-verify"
import type { FsPort, RedactPort } from "./types"

/**
 * Transport seam — a minimal listening surface. Tier-1 host adapters bind
 * a concrete implementation (e.g. `node:http`, Cloudflare Workers, Bun's
 * `Bun.serve`).
 */
export interface WebhookTransportPort {
  listen(
    port: number,
    handler: (req: WebhookRequest) => Promise<WebhookResponse>,
  ): Promise<WebhookHandle>
}

export interface WebhookRequest {
  readonly rawBody: Uint8Array
  readonly headers: Record<string, string | undefined>
}

export interface WebhookResponse {
  readonly status: number
  readonly body?: string
}

export interface WebhookHandle {
  close(): Promise<void>
}

export interface WebhookEventSourceOpts {
  readonly envPort: EnvPort
  readonly clockPort: ClockPort
  readonly fsPort: FsPort
  readonly transport: WebhookTransportPort
  readonly redactPort: RedactPort
  readonly deliveryStore: DeliveryStore
  /** Secret env-var name. Default `"QUANTA_GH_WEBHOOK_SECRET"`. */
  readonly secretEnv?: string
  readonly listenPort?: number
}

/**
 * Build a webhook-driven {@link TriggerSourcePort}. Currently a scaffold —
 * `poll()` throws `NOT_IMPLEMENTED` so callers cannot accidentally rely on
 * an unimplemented hot path. The factory itself succeeds (port wiring is
 * validated at boot) so composition can be exercised in tests.
 */
export const createWebhookEventSource = (opts: WebhookEventSourceOpts): TriggerSourcePort => {
  // Boot-time wiring sanity — every port must be defined; the secret env name
  // is resolved (the actual secret is read at request time, not boot).
  if (opts.transport === undefined) {
    throw new Error("createWebhookEventSource: transport port required (Tier-1)")
  }
  if (opts.redactPort === undefined) {
    throw new Error("createWebhookEventSource: redactPort required (Tier-1)")
  }
  // Reference the helper so its symbol is preserved even when impl is gated.
  void verifyHubSignature256
  return {
    async poll(): Promise<readonly ProactiveTrigger[]> {
      throw new Error(
        "ADR-0312 webhook event source NOT_IMPLEMENTED — Tier-1 boundary. Use createActionsEventSource (ADR-0311) on the GH Actions path.",
      )
    },
  }
}
