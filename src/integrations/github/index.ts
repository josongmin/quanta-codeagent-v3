/**
 * Public seam for `@/integrations/github` — ADR-0311 / 0312 / 0313 / 0314.
 *
 * Tier-0 (GH Actions, default-OFF):
 *   - `createActionsEventSource` reads `GITHUB_EVENT_PATH` once and emits a
 *     ProactiveTrigger on a recognized mention. Delivery-id dedup + bot guard
 *     + trust-scope gate.
 *   - `createPrOutputSink` posts comments/reviews with redaction + idempotency
 *     markers. Boot-time refuses to wire without a RedactPort.
 *   - `loadPrContext` pulls 4-shot gh context for the agent's first turn.
 *
 * Tier-1 (host-decided webhook, NOT_IMPLEMENTED):
 *   - `createWebhookEventSource` is a scaffold; `verifyHubSignature256` is
 *     the HMAC verifier so the transport adapter can rely on a tested contract.
 */

export type { NormalizeOpts, ParseGhEventOpts } from "./event-payload"
export { normalizeGhEvent, parseGhEventFile, safeReadEventFile } from "./event-payload"
export type { ActionsEventSourceOpts } from "./event-source-actions"
export {
  createActionsEventSource,
  GH_ACTIONS_TRIGGER_ENV,
  matchMention,
} from "./event-source-actions"
export type { DeliveryStore, DeliveryStoreOpts } from "./idempotency"
export { computeIdempotencyKey, createDeliveryStore } from "./idempotency"
export type { MentionFilter, MentionFilterOpts } from "./mention-filter"
export { createMentionFilter } from "./mention-filter"
export type { LoadPrContextOpts } from "./pr-context-loader"
export { loadPrContext } from "./pr-context-loader"
export type { PrOutputSink, PrOutputSinkOpts } from "./pr-output-sink"
export { createPrOutputSink } from "./pr-output-sink"
export { verifyHubSignature256 } from "./signature-verify"
export type {
  FsPort,
  GhEventKind,
  IdempotencyKey,
  MentionMatch,
  NormalizedGhEvent,
  NormalizedRepo,
  NormalizedSender,
  OutputPostResult,
  OutputSinkKind,
  PrContext,
  PrContextComment,
  RedactPort,
  ReviewVerdict,
  SenderType,
  TrustScope,
} from "./types"
export { ALL_GH_EVENT_KINDS } from "./types"
export type {
  WebhookEventSourceOpts,
  WebhookHandle,
  WebhookRequest,
  WebhookResponse,
  WebhookTransportPort,
} from "./webhook-server"
export { createWebhookEventSource } from "./webhook-server"
