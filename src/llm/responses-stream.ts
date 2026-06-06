import { errMessage, LLMError, logger } from "@/shared"
import type { LLMErrorKind, LLMProvider } from "@/shared/errors"
import {
  buildResponsesBody,
  buildResponsesInputItems,
  emitResponsesCheckpoint,
  fingerprintResponsesBody,
  parseResponsesEvents,
  parseResponsesSSEFrames,
  type ResponsesCompletionMeta,
  type ResponsesInputItem,
  strictExtensionTail,
} from "./openai-responses-wire"
import type { ResponsesContinuationStore } from "./responses-continuation-store"
import { withStreamTimeout } from "./stream-timeout"
import type { LlmTransportId } from "./target-metadata"
import type { StreamEvent, StreamInput } from "./types"

export type ResponsesFetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * H15 — per-route reasoning carry-over store (OpenAI-Responses ONLY).
 *
 * Sibling to {@link ResponsesContinuationStore}, keyed by the SAME `routeKey`
 * (the prompt-cache key). Holds the opaque, re-emittable reasoning INPUT items
 * captured from prior turns so the NEXT turn's Responses input can lead with
 * them (chain-of-thought continuity). The bodies are ZDR ciphertext — this
 * store never decodes them.
 *
 * Default-OFF byte-identity: a host that does not wire a store (the default)
 * gets exactly today's behavior. The store is only consulted/written when
 * carry-over is on AND a store instance is threaded through.
 *
 * Closed, append-and-replace-per-route contract:
 *  - `get` returns the prior turn's captured items (`[]` when none).
 *  - `put` REPLACES the route's items with the new capture (the latest turn's
 *    reasoning supersedes — Codex re-feeds the most recent reasoning, not the
 *    full transcript, so the input never grows unbounded).
 *  - `clear` drops one route; `clearAll` resets (session boundary).
 */
export interface ResponsesReasoningCarryoverStore {
  get(routeKey: string): readonly ResponsesInputItem[]
  put(routeKey: string, items: readonly ResponsesInputItem[]): void
  clear(routeKey: string): void
  clearAll(): void
}

/** Default in-memory {@link ResponsesReasoningCarryoverStore}. Pure container —
 *  no clock, no I/O. The host owns the instance and re-feeds it across turns. */
export const defaultResponsesReasoningCarryoverStore = (): ResponsesReasoningCarryoverStore => {
  const store = new Map<string, readonly ResponsesInputItem[]>()
  return {
    get(routeKey) {
      return store.get(routeKey) ?? []
    },
    put(routeKey, items) {
      store.set(routeKey, Object.freeze(items.slice()))
    },
    clear(routeKey) {
      store.delete(routeKey)
    },
    clearAll() {
      store.clear()
    },
  }
}

export interface ResponsesPreparedRequest {
  readonly body: Record<string, unknown>
  readonly fullBody: Record<string, unknown>
  readonly routeKey?: string
  readonly requestFingerprint?: string
  readonly fullInputItems?: readonly ResponsesInputItem[]
  readonly resumedFromResponseId?: string
  readonly continuationEvent: Extract<StreamEvent, { type: "llm_continuation" }>
}

export interface PrepareResponsesContinuationRequestArgs {
  readonly input: StreamInput
  readonly model: string
  readonly transportId: LlmTransportId
  readonly maxOutputTokens?: number
  readonly continuationStore?: ResponsesContinuationStore
  /** OpenAI `service_tier` — env-derived (`QUANTA_SERVICE_TIER`/`QUANTA_FAST`)
   *  at the composition root, threaded through to `buildResponsesBody` as plain
   *  config. Omitted ⇒ no `service_tier` field. */
  readonly serviceTier?: string
  /** Reasoning effort — env-derived (`QUANTA_REASONING_EFFORT`) at the
   *  composition root, threaded through as plain config. Omitted ⇒ default. */
  readonly reasoningEffort?: string
  /** H15 reasoning carry-over gate (`QUANTA_REASONING_CARRYOVER`). Default-OFF
   *  / omitted ⇒ byte-identical: no re-emit, no `include`, nothing read from
   *  {@link reasoningCarryoverStore}. OpenAI-Responses ONLY. */
  readonly reasoningCarryover?: boolean
  /** H15 — the per-route reasoning carry-over store. Only consulted when
   *  {@link reasoningCarryover} is `true`. Omitted ⇒ no re-emit (the gate alone
   *  does nothing without a store). */
  readonly reasoningCarryoverStore?: ResponsesReasoningCarryoverStore
}

export interface ResponsesStreamConfig {
  readonly provider: LLMProvider
  readonly transportId: LlmTransportId
  readonly model: string
  readonly input: StreamInput
  readonly request: ResponsesPreparedRequest
  readonly fetchImpl: ResponsesFetchLike
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: {
    readonly firstChunkMs: number
    readonly idleMs: number
  }
  readonly continuationStore?: ResponsesContinuationStore
  readonly retryableResumeStatuses?: ReadonlySet<number>
  readonly disableResumeOnStatuses?: ReadonlySet<number>
  /** H15 reasoning carry-over gate. Default-OFF / omitted ⇒ byte-identical
   *  (no capture, no persist). OpenAI-Responses ONLY. */
  readonly reasoningCarryover?: boolean
  /** H15 — per-route carry-over store. Only written when {@link reasoningCarryover}
   *  is `true` AND a `routeKey` is resolvable. */
  readonly reasoningCarryoverStore?: ResponsesReasoningCarryoverStore
}

const DEFAULT_RETRYABLE_RESUME_STATUSES = new Set([400, 404, 409, 422])
const RESPONSES_SURFACE_ID = "openai-responses" as const

const normalizeRouteKey = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined

const continuationEvent = (args: {
  readonly transportId: LlmTransportId
  readonly phase: "prepare" | "retry"
  readonly mode: "full" | "resume" | "full_retry"
  readonly reason: Extract<
    Extract<StreamEvent, { type: "llm_continuation" }>["reason"],
    | "no_prompt_cache_key"
    | "no_state_store"
    | "resume_disabled"
    | "no_entry"
    | "request_fingerprint_mismatch"
    | "non_resumable"
    | "strict_extension_miss"
    | "prepared_resume"
    | "stale_previous_response"
    | "resume_rejected"
  >
  readonly statusCode?: number
}): Extract<StreamEvent, { type: "llm_continuation" }> => ({
  type: "llm_continuation",
  surfaceId: RESPONSES_SURFACE_ID,
  transportId: args.transportId,
  phase: args.phase,
  mode: args.mode,
  reason: args.reason,
  ...(args.statusCode !== undefined ? { statusCode: args.statusCode } : {}),
})

export const responsesStatusToKind = (status: number): LLMErrorKind => {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return "bad_request"
  if (status >= 500 && status < 600) return "server_error"
  return "unknown"
}

/** L6 M4: read an error-response body, returning `""` on failure but logging
 *  WHY the read failed (truncated stream / aborted socket) so the lost
 *  diagnostic context is at least visible to an operator. The status/kind
 *  classification is unaffected — only the human-readable tail is best-effort. */
const readBodyTextOrLog = async (res: Response, provider: LLMProvider): Promise<string> => {
  try {
    return await res.text()
  } catch (e) {
    logger.warn("responses-stream: failed to read error response body", {
      provider,
      status: res.status,
      error: errMessage(e),
    })
    return ""
  }
}

export const buildResponsesFirstChunkTimeoutError = (ms: number, provider: LLMProvider): LLMError =>
  new LLMError(`LLM stream first-chunk timeout after ${ms}ms (provider sent no data; timed out)`, {
    kind: "stream_corrupt",
    provider,
    cause: new Error(`first-chunk timeout @${ms}ms`),
  })

export const linkAbortController = (
  signal: AbortSignal | undefined,
): { controller: AbortController; detach: () => void } => {
  const controller = new AbortController()
  const onAbort = (): void => {
    try {
      controller.abort(signal?.reason)
    } catch {
      controller.abort()
    }
  }
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  return {
    controller,
    detach: () => signal?.removeEventListener("abort", onAbort),
  }
}

export const prepareResponsesContinuationRequest = (
  args: PrepareResponsesContinuationRequestArgs,
): ResponsesPreparedRequest => {
  const routeKey = normalizeRouteKey(args.input.promptCacheKey)
  const fullInputItems = buildResponsesInputItems(args.input.messages)
  // H15 — resolve the prior turns' captured reasoning items for THIS route.
  // Default-OFF byte-identity: when carry-over is off, no store, or no routeKey,
  // `priorReasoning` stays empty and the carry-over opts collapse to `{}` — so
  // every `buildResponsesBody` call below is byte-identical to today. OpenAI-
  // Responses only (this prepare path is the Responses surface).
  const priorReasoning =
    args.reasoningCarryover === true &&
    args.reasoningCarryoverStore !== undefined &&
    routeKey !== undefined
      ? args.reasoningCarryoverStore.get(routeKey)
      : []
  const carryoverOpts =
    priorReasoning.length > 0
      ? { reasoningCarryover: true as const, priorReasoningItems: priorReasoning }
      : {}
  const fullBody = buildResponsesBody(args.input, args.model, {
    inputItems: fullInputItems,
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    ...(args.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
    ...carryoverOpts,
    store: false,
  })
  const requestFingerprint = fingerprintResponsesBody(fullBody)
  if (routeKey === undefined || args.continuationStore === undefined) {
    return {
      body: fullBody,
      fullBody,
      ...(routeKey !== undefined ? { routeKey } : {}),
      requestFingerprint,
      fullInputItems,
      continuationEvent: continuationEvent({
        transportId: args.transportId,
        phase: "prepare",
        mode: "full",
        reason: routeKey === undefined ? "no_prompt_cache_key" : "no_state_store",
      }),
    }
  }
  if (!args.continuationStore.canResume(routeKey)) {
    return {
      body: fullBody,
      fullBody,
      routeKey,
      requestFingerprint,
      fullInputItems,
      continuationEvent: continuationEvent({
        transportId: args.transportId,
        phase: "prepare",
        mode: "full",
        reason: "resume_disabled",
      }),
    }
  }

  const previous = args.continuationStore.get(routeKey)
  if (previous === null || previous.responseId === "") {
    return {
      body: fullBody,
      fullBody,
      routeKey,
      requestFingerprint,
      fullInputItems,
      continuationEvent: continuationEvent({
        transportId: args.transportId,
        phase: "prepare",
        mode: "full",
        reason: "no_entry",
      }),
    }
  }
  if (previous.resumable !== true) {
    return {
      body: fullBody,
      fullBody,
      routeKey,
      requestFingerprint,
      fullInputItems,
      continuationEvent: continuationEvent({
        transportId: args.transportId,
        phase: "prepare",
        mode: "full",
        reason: "non_resumable",
      }),
    }
  }
  if (previous.requestFingerprint !== requestFingerprint) {
    return {
      body: fullBody,
      fullBody,
      routeKey,
      requestFingerprint,
      fullInputItems,
      continuationEvent: continuationEvent({
        transportId: args.transportId,
        phase: "prepare",
        mode: "full",
        reason: "request_fingerprint_mismatch",
      }),
    }
  }

  const baseline = [...previous.inputItems, ...previous.outputItems]
  const tail = strictExtensionTail(fullInputItems, baseline)
  if (tail === null) {
    return {
      body: fullBody,
      fullBody,
      routeKey,
      requestFingerprint,
      fullInputItems,
      continuationEvent: continuationEvent({
        transportId: args.transportId,
        phase: "prepare",
        mode: "full",
        reason: "strict_extension_miss",
      }),
    }
  }

  return {
    body: buildResponsesBody(args.input, args.model, {
      inputItems: tail,
      previousResponseId: previous.responseId,
      ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
      ...(args.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
      ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
      store: false,
    }),
    fullBody,
    routeKey,
    requestFingerprint,
    fullInputItems,
    resumedFromResponseId: previous.responseId,
    continuationEvent: continuationEvent({
      transportId: args.transportId,
      phase: "prepare",
      mode: "resume",
      reason: "prepared_resume",
    }),
  }
}

const canPersistContinuation = (
  request: ResponsesPreparedRequest,
  store: ResponsesContinuationStore | undefined,
): request is ResponsesPreparedRequest & {
  readonly routeKey: string
  readonly requestFingerprint: string
  readonly fullInputItems: readonly ResponsesInputItem[]
} => {
  return (
    store !== undefined &&
    request.routeKey !== undefined &&
    request.requestFingerprint !== undefined &&
    request.fullInputItems !== undefined
  )
}

const buildCheckpoint = (args: {
  readonly input: StreamInput
  readonly model: string
  readonly transportId: LlmTransportId
  readonly meta: ResponsesCompletionMeta
}): void => {
  emitResponsesCheckpoint(args.input.onCheckpoint, {
    type: "openai-responses",
    model: args.meta.model ?? args.model,
    surfaceId: "openai-responses",
    transportId: args.transportId,
    responseId: args.meta.responseId ?? "",
    ...(args.input.promptCacheKey !== undefined
      ? { promptCacheKey: args.input.promptCacheKey }
      : {}),
    ...(args.input.promptCacheRetention !== undefined
      ? { promptCacheRetention: args.input.promptCacheRetention }
      : {}),
  })
}

export async function* streamResponsesSurface(
  config: ResponsesStreamConfig,
): AsyncIterable<StreamEvent> {
  let prepared = config.request
  const request = linkAbortController(config.input.signal)
  let retriedAfterResumeFailure = false
  const retryableResumeStatuses =
    config.retryableResumeStatuses ?? DEFAULT_RETRYABLE_RESUME_STATUSES
  const disableResumeOnStatuses = config.disableResumeOnStatuses

  try {
    const postBody = async (body: Record<string, unknown>): Promise<Response> => {
      let firstChunkTimer: ReturnType<typeof setTimeout> | undefined
      try {
        firstChunkTimer = setTimeout(() => {
          request.controller.abort(
            buildResponsesFirstChunkTimeoutError(config.timeoutMs.firstChunkMs, config.provider),
          )
        }, config.timeoutMs.firstChunkMs)

        config.input.turnTimingCapture?.markRequestSent()
        return await config.fetchImpl(config.url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify(body),
          signal: request.controller.signal,
        })
      } finally {
        if (firstChunkTimer !== undefined) clearTimeout(firstChunkTimer)
      }
    }

    yield prepared.continuationEvent

    let res = await postBody(prepared.body)
    if (
      !res.ok &&
      prepared.resumedFromResponseId !== undefined &&
      prepared.routeKey !== undefined &&
      config.continuationStore !== undefined &&
      !retriedAfterResumeFailure &&
      retryableResumeStatuses.has(res.status)
    ) {
      if (disableResumeOnStatuses?.has(res.status) === true) {
        config.continuationStore.markResumeUnsupported(prepared.routeKey)
      }
      config.continuationStore.clear(prepared.routeKey)
      retriedAfterResumeFailure = true
      yield continuationEvent({
        transportId: config.transportId,
        phase: "retry",
        mode: "full_retry",
        reason:
          disableResumeOnStatuses?.has(res.status) === true
            ? "resume_rejected"
            : "stale_previous_response",
        statusCode: res.status,
      })
      prepared = {
        body: prepared.fullBody,
        fullBody: prepared.fullBody,
        ...(prepared.routeKey !== undefined ? { routeKey: prepared.routeKey } : {}),
        ...(prepared.requestFingerprint !== undefined
          ? { requestFingerprint: prepared.requestFingerprint }
          : {}),
        ...(prepared.fullInputItems !== undefined
          ? { fullInputItems: prepared.fullInputItems }
          : {}),
        continuationEvent: continuationEvent({
          transportId: config.transportId,
          phase: "retry",
          mode: "full_retry",
          reason:
            disableResumeOnStatuses?.has(res.status) === true
              ? "resume_rejected"
              : "stale_previous_response",
          statusCode: res.status,
        }),
      }
      res = await postBody(prepared.body)
    }

    if (!res.ok) {
      // L6 M4: the provider error body carries the actionable diagnostic. A
      // silent `.catch(() => "")` discards it on a read failure — keep the
      // status/kind classification, but log WHY the body was unreadable so an
      // operator isn't left with a bare status code.
      const text = await readBodyTextOrLog(res, config.provider)
      throw new LLMError(
        `${config.provider} responses request failed: ${res.status} ${res.statusText}` +
          (text ? ` — ${text.slice(0, 200)}` : ""),
        {
          kind: responsesStatusToKind(res.status),
          statusCode: res.status,
          provider: config.provider,
        },
      )
    }
    if (res.body === null) {
      throw new LLMError(`${config.provider} responses stream has no body`, {
        kind: "stream_corrupt",
        provider: config.provider,
      })
    }

    // jun-6 account-ratelimit-snapshot — OPTIONAL success-path header capture
    // (mirrors the Anthropic adapter's `.withResponse()` hook). Present ONLY
    // when the loop wired the hook (gate QUANTA_RATELIMIT_PROACTIVE ON). The
    // raw `Response`'s `headers.get` is the case-insensitive accessor the
    // snapshot parser expects. Best-effort: a faulty quota consumer must never
    // break the live stream. Absent ⇒ no call, byte-identical to pre-feature.
    if (config.input.onResponseHeaders !== undefined) {
      try {
        config.input.onResponseHeaders((name) => res.headers.get(name))
      } catch {
        // swallow — header capture is non-essential observability.
      }
    }

    const outputItems: ResponsesInputItem[] = []
    // H15 — captured re-emittable reasoning items for THIS turn. Stays empty
    // unless carry-over is on AND the wire surfaces `item.reasoningItem` (which
    // it only does when on). Order-preserving (append in stream order).
    const capturedReasoning: ResponsesInputItem[] = []
    let resumable = true
    let completed: ResponsesCompletionMeta | null = null
    const rawFrames = parseResponsesSSEFrames(res.body) as AsyncIterable<{
      readonly event?: string
      readonly data: string
    }> & {
      controller?: AbortController
    }
    rawFrames.controller = request.controller
    const guardedFrames = withStreamTimeout(rawFrames, {
      firstChunkMs: config.timeoutMs.firstChunkMs,
      idleMs: config.timeoutMs.idleMs,
      provider: config.provider,
      ...(config.input.signal !== undefined ? { signal: config.input.signal } : {}),
      ...(config.input.onChunk !== undefined ? { onChunk: config.input.onChunk } : {}),
    })

    try {
      yield* parseResponsesEvents(guardedFrames, {
        provider: config.provider,
        fallbackModel: config.model,
        // H15 — pass the capture gate THROUGH to the wire. Default-OFF ⇒ omitted
        // (the wire's `onOutputItemDone` payload is the legacy 2-field shape and
        // `reasoningItem` is never surfaced ⇒ byte-identical).
        ...(config.reasoningCarryover === true ? { reasoningCarryover: true } : {}),
        onCompleted: (meta) => {
          completed = meta
          if ((meta.usage?.reasoning ?? 0) > 0) resumable = false
          if (typeof meta.responseId === "string" && meta.responseId !== "") {
            buildCheckpoint({
              input: config.input,
              model: config.model,
              transportId: config.transportId,
              meta,
            })
          }
        },
        onOutputItemDone: (item) => {
          // H15 — capture the re-emittable reasoning item (present ONLY when
          // carry-over is on and the item carried usable `encrypted_content`).
          // This is ORTHOGONAL to the resume/baseline path below: a reasoning
          // item still has `normalized === null`, so resumability is unchanged.
          if (item.reasoningItem !== undefined) capturedReasoning.push(item.reasoningItem)
          if (item.normalized === null) {
            resumable = false
            return
          }
          outputItems.push(item.normalized)
        },
        onReasoning: () => {
          resumable = false
        },
      })
    } catch (error) {
      if (config.continuationStore !== undefined && prepared.routeKey !== undefined) {
        config.continuationStore.clear(prepared.routeKey)
      }
      throw error
    }

    // H15 — persist this turn's captured reasoning for the NEXT turn's re-emit.
    // Independent of the continuation (prompt-cache resume) store: carry-over
    // works on the full-body path too. Default-OFF byte-identity: this whole
    // block is skipped unless carry-over is on, a store is wired, AND a routeKey
    // resolved. `put` REPLACES the route's items (latest reasoning supersedes),
    // and an empty capture CLEARS the route so a turn that produced no reasoning
    // does not re-feed a stale chain.
    const carryoverStore = config.reasoningCarryoverStore
    if (
      config.reasoningCarryover === true &&
      carryoverStore !== undefined &&
      prepared.routeKey !== undefined
    ) {
      if (capturedReasoning.length > 0) carryoverStore.put(prepared.routeKey, capturedReasoning)
      else carryoverStore.clear(prepared.routeKey)
    }

    const continuationStore = config.continuationStore
    if (continuationStore === undefined || !canPersistContinuation(prepared, continuationStore)) {
      return
    }

    const completedMeta = completed as ResponsesCompletionMeta | null
    const responseId =
      completedMeta !== null && typeof completedMeta.responseId === "string"
        ? completedMeta.responseId
        : undefined
    if (typeof responseId !== "string" || responseId === "") {
      continuationStore.clear(prepared.routeKey)
      return
    }

    continuationStore.put({
      routeKey: prepared.routeKey,
      responseId,
      requestFingerprint: prepared.requestFingerprint,
      inputItems: prepared.fullInputItems,
      outputItems,
      resumable,
    })
  } catch (error) {
    if (
      request.controller.signal.aborted &&
      request.controller.signal.reason instanceof LLMError &&
      error === request.controller.signal.reason
    ) {
      throw request.controller.signal.reason
    }
    throw LLMError.fromSdkError(config.provider, error, `${config.provider} responses stream error`)
  } finally {
    request.detach()
  }
}
