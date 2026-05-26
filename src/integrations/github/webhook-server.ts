/**
 * ADR-0312 — Tier-1 webhook event source (live implementation).
 *
 * Wires the verified-HMAC + dedup + mention-filter pipeline behind a transport
 * port (`WebhookTransportPort`). The transport is responsible for binding a
 * concrete HTTP server (e.g. `Bun.serve`, `node:http`); the slice itself
 * remains free of direct network IO so the slice-fence rule
 * (no `node:fs` / `node:http` in slice core) holds.
 *
 * Flow on every inbound POST /webhook:
 *   1. method/path gate (POST + `/webhook`),
 *   2. raw-body cap (10MB hard ceiling — GitHub's documented max is 25MB but
 *      no legitimate trigger payload approaches that),
 *   3. `verifyHubSignature256` against the EXACT bytes (timing-safe),
 *   4. delivery-id dedup (`DeliveryStore` from `idempotency.ts`),
 *   5. JSON parse + `normalizeGhEvent` (boundary; hostile JSON collapses to
 *      400, never throws),
 *   6. mention-filter (bot + trust-scope + self-loop marker),
 *   7. enqueue into the bounded in-memory FIFO,
 *   8. respond 202 (accepted).
 *
 * `poll()` drains the queue (consumer pull cadence — same shape as the GH
 * Actions / CI sources).
 *
 * Boot-time invariant: an empty `secret` throws BEFORE we wire the transport,
 * so a misconfigured host can never start a listening server that would
 * silently accept all payloads.
 */

import type { ClockPort, ProactiveTrigger, TriggerReason, TriggerSourcePort } from "@/reactor"
import { normalizeGhEvent } from "./event-payload"
import { createDeliveryStore, type DeliveryStore } from "./idempotency"
import { createMentionFilter, type MentionFilter } from "./mention-filter"
import { verifyHubSignature256 } from "./signature-verify"
import type { GhEventKind, NormalizedGhEvent, TrustScope } from "./types"

/** Default queue capacity. Bounded FIFO; new arrivals while full are rejected
 *  with 503 (the host SHOULD treat this as backpressure — GH retries). */
const DEFAULT_QUEUE_CAPACITY = 256

/** Default trigger phrases — mirrors `event-source-actions.ts`. */
const DEFAULT_TRIGGER_PHRASES: ReadonlyArray<string> = ["@quanta", "/quanta"]

/** Hard ceiling on request body size. Anything larger is rejected with 413
 *  BEFORE the HMAC compute (avoids burning CPU on a hostile body). */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024

/** Hard ceiling on individual header value length. Anything larger is
 *  rejected with 431 — defense against header-bomb DoS. */
export const MAX_HEADER_VALUE_BYTES = 8 * 1024

/** Snippet cap on the `simulatedMessage` field. Mirrors actions source. */
const SNIPPET_MAX_CHARS = 280

export interface WebhookTransportPort {
  listen(opts: {
    onRequest: (req: WebhookRequest) => Promise<WebhookResponse>
  }): Promise<WebhookHandle>
}

export interface WebhookRequest {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

export interface WebhookResponse {
  readonly status: number
  readonly body?: string
}

export interface WebhookHandle {
  close(): Promise<void>
}

export interface WebhookEventSourceOpts {
  readonly transport: WebhookTransportPort
  readonly secret: string
  readonly clockPort: ClockPort
  readonly deliveryStore?: DeliveryStore
  readonly mentionFilter?: MentionFilter
  readonly triggerPhrases?: readonly string[]
  readonly requireTrustScope?: TrustScope
  readonly allowBots?: boolean
  readonly queueCapacity?: number
  readonly onError?: (msg: string) => void
}

export interface WebhookEventSource extends TriggerSourcePort {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Build a webhook-driven `TriggerSourcePort` with `start` / `stop` lifecycle.
 *
 * Throws synchronously when `secret` is empty — this is the boot-time fence
 * against an "open" webhook server.
 */
export const createWebhookEventSource = (opts: WebhookEventSourceOpts): WebhookEventSource => {
  validateOpts(opts)
  const cap = Math.max(1, opts.queueCapacity ?? DEFAULT_QUEUE_CAPACITY)
  const deliveryStore = opts.deliveryStore ?? createDeliveryStore()
  const filter =
    opts.mentionFilter ??
    createMentionFilter({
      triggerPhrases: opts.triggerPhrases ?? DEFAULT_TRIGGER_PHRASES,
      requireTrustScope: opts.requireTrustScope ?? "collaborator",
      allowBots: opts.allowBots ?? false,
    })
  const onError = opts.onError ?? noop
  const queue: ProactiveTrigger[] = []
  let handle: WebhookHandle | undefined

  const handleRequest = async (req: WebhookRequest): Promise<WebhookResponse> => {
    return routeRequest({
      req,
      secret: opts.secret,
      filter,
      deliveryStore,
      queue,
      queueCap: cap,
      onError,
    })
  }

  return {
    async start(): Promise<void> {
      if (handle !== undefined) return
      handle = await opts.transport.listen({ onRequest: handleRequest })
    },
    async stop(): Promise<void> {
      const h = handle
      handle = undefined
      if (h !== undefined) {
        try {
          await h.close()
        } catch (err) {
          onError(`webhook stop: ${stringifyError(err)}`)
        }
      }
    },
    async poll(): Promise<readonly ProactiveTrigger[]> {
      if (queue.length === 0) return []
      const drained = queue.splice(0, queue.length)
      return drained
    },
  }
}

const validateOpts = (opts: WebhookEventSourceOpts): void => {
  if (opts.transport === undefined || opts.transport === null) {
    throw new Error("createWebhookEventSource: transport port required")
  }
  if (typeof opts.secret !== "string" || opts.secret.length === 0) {
    throw new Error("createWebhookEventSource: secret must be a non-empty string (no open bypass)")
  }
  if (opts.clockPort === undefined || opts.clockPort === null) {
    throw new Error("createWebhookEventSource: clockPort required")
  }
}

interface RouteDeps {
  readonly req: WebhookRequest
  readonly secret: string
  readonly filter: MentionFilter
  readonly deliveryStore: DeliveryStore
  readonly queue: ProactiveTrigger[]
  readonly queueCap: number
  readonly onError: (msg: string) => void
}

const routeRequest = (deps: RouteDeps): WebhookResponse => {
  const guard = checkRequestGuards(deps.req)
  if (guard !== undefined) return guard

  if (
    !verifyHubSignature256(deps.req.body, headerOf(deps.req, "x-hub-signature-256"), deps.secret)
  ) {
    return { status: 401, body: "invalid signature" }
  }

  const deliveryId = headerOf(deps.req, "x-github-delivery")
  if (deliveryId.length === 0) {
    return { status: 400, body: "missing X-GitHub-Delivery" }
  }
  if (deps.deliveryStore.has(deliveryId)) {
    return { status: 202, body: "duplicate delivery (dedup)" }
  }

  const kind = parseEventKind(headerOf(deps.req, "x-github-event"))
  if (kind === undefined) {
    return { status: 202, body: "ignored event kind" }
  }

  const payload = parseJsonBody(deps.req.body)
  if (payload === undefined) {
    return { status: 400, body: "invalid JSON body" }
  }

  const event = normalizeGhEvent({ raw: payload, kind, deliveryId })
  if (event === undefined) {
    return { status: 202, body: "unrecognized event payload" }
  }

  if (kind !== "workflow_dispatch") {
    const m = deps.filter.evaluate(event)
    if (!m.matched) {
      // Record delivery so a retry of the SAME id doesn't re-evaluate (filter
      // is deterministic on event content).
      deps.deliveryStore.add(deliveryId)
      return { status: 202, body: "no mention" }
    }
  }

  if (deps.queue.length >= deps.queueCap) {
    deps.onError(`webhook queue full (cap=${deps.queueCap})`)
    return { status: 503, body: "queue full" }
  }

  deps.queue.push(buildTrigger(event, kind))
  deps.deliveryStore.add(deliveryId)
  return { status: 202, body: "accepted" }
}

const checkRequestGuards = (req: WebhookRequest): WebhookResponse | undefined => {
  if (req.path !== "/webhook") {
    return { status: 404, body: "not found" }
  }
  if (req.method.toUpperCase() !== "POST") {
    return { status: 405, body: "method not allowed" }
  }
  if (req.body.length === 0) {
    return { status: 400, body: "empty body" }
  }
  if (req.body.length > MAX_REQUEST_BYTES) {
    return { status: 413, body: "payload too large" }
  }
  const oversized = findOversizedHeader(req.headers)
  if (oversized !== undefined) {
    return { status: 431, body: `header too large: ${oversized}` }
  }
  return undefined
}

const findOversizedHeader = (headers: Record<string, string>): string | undefined => {
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue
    // Cheap byte estimate — header values are ASCII in practice. Using
    // `.length` (UTF-16 code units) is an UPPER bound for ASCII so this
    // never under-reports for the inputs GH actually sends.
    if (v.length > MAX_HEADER_VALUE_BYTES) return k
  }
  return undefined
}

const headerOf = (req: WebhookRequest, name: string): string => {
  const direct = req.headers[name]
  if (typeof direct === "string") return direct
  // Case-insensitive fallback — both Bun and node:http normalize to
  // lowercase but a custom transport adapter might not.
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v
  }
  return ""
}

const KIND_ALLOWLIST: ReadonlyArray<GhEventKind> = [
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "pull_request",
  "issues",
  "workflow_dispatch",
]

const parseEventKind = (raw: string): GhEventKind | undefined => {
  if (raw.length === 0) return undefined
  return (KIND_ALLOWLIST as readonly string[]).includes(raw) ? (raw as GhEventKind) : undefined
}

const parseJsonBody = (body: Uint8Array): unknown => {
  try {
    const text = Buffer.from(body).toString("utf8")
    if (text.length === 0) return undefined
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

const buildTrigger = (event: NormalizedGhEvent, kind: GhEventKind): ProactiveTrigger => {
  const reason: TriggerReason = kind === "workflow_dispatch" ? "manual_resume" : "pr_comment"
  const url = derivePrUrl(event)
  return Object.freeze({
    reason,
    evidence: Object.freeze({ kind: "url" as const, value: url }),
    simulatedMessage: buildSimulatedMessage(event, kind),
    abortSignal: new AbortController().signal,
  })
}

const derivePrUrl = (event: NormalizedGhEvent): string => {
  if (event.prNumber !== undefined) {
    return `https://github.com/${event.repo.owner}/${event.repo.name}/pull/${event.prNumber}`
  }
  return `https://github.com/${event.repo.owner}/${event.repo.name}`
}

const buildSimulatedMessage = (event: NormalizedGhEvent, kind: GhEventKind): string => {
  const prSeg = event.prNumber !== undefined ? ` on PR #${event.prNumber}` : ""
  const head = kind === "workflow_dispatch" ? "manual workflow_dispatch" : (event.action ?? kind)
  const snippet = clampSnippet(event.body ?? "")
  return `GitHub @${event.sender.login}${prSeg}: ${head}${snippet ? ` → ${snippet}` : ""}`
}

const clampSnippet = (body: string): string => {
  const trimmed = body.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) return ""
  if (trimmed.length <= SNIPPET_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, SNIPPET_MAX_CHARS - 1)}…`
}

const stringifyError = (err: unknown): string => {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return "unknown error"
  }
}

const noop = (_msg: string): void => {
  /* intentional no-op */
}
