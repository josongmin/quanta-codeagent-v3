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
 * Tier-1 (host-decided webhook, live):
 *   - `createWebhookEventSource` boots a webhook-driven trigger source behind
 *     a transport seam (`WebhookTransportPort`). Two production adapters
 *     ship in `webhook-transports.ts`: `createBunWebhookTransport` (preferred
 *     under Bun) and `createNodeWebhookTransport` (node:http fallback).
 *   - `verifyHubSignature256` exposes the HMAC contract for adapter authors.
 */

export { defaultDeliveryPersist } from "./adapters/delivery-persist-fs"
export type { NormalizeOpts, ParseGhEventOpts } from "./event-payload"
export { normalizeGhEvent, parseGhEventFile, safeReadEventFile } from "./event-payload"
export type { ActionsEventSourceOpts } from "./event-source-actions"
export {
  createActionsEventSource,
  GH_ACTIONS_TRIGGER_ENV,
  matchMention,
} from "./event-source-actions"
export type {
  DeliveryPersistPort,
  DeliveryStore,
  DeliveryStoreOpts,
  DurableDeliveryStore,
  DurableDeliveryStoreOpts,
} from "./idempotency"
export {
  computeIdempotencyKey,
  createDeliveryStore,
  createDurableDeliveryStore,
} from "./idempotency"
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
export { ALL_GH_EVENT_KINDS, asIdempotencyKey } from "./types"
export type {
  LoadWebhookSecretConfigDeps,
  WebhookSecretConfig,
  WebhookSecretMode,
} from "./webhook-secret-resolver"
export {
  extractAppKey,
  loadWebhookSecretConfig,
  WEBHOOK_PATH_PREFIX,
} from "./webhook-secret-resolver"
export type {
  SecretResolverPort,
  WebhookEventSource,
  WebhookEventSourceOpts,
  WebhookHandle,
  WebhookRequest,
  WebhookResponse,
  WebhookTransportPort,
} from "./webhook-server"
export { createWebhookEventSource, MAX_REQUEST_BYTES } from "./webhook-server"
export type { BunWebhookTransportOpts, NodeWebhookTransportOpts } from "./webhook-transports"
export { createBunWebhookTransport, createNodeWebhookTransport } from "./webhook-transports"
