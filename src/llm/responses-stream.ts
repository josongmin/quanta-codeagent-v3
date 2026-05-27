import { LLMError } from "@/shared"
import type { LLMErrorKind, LLMProvider } from "@/shared/errors"
import {
  buildResponsesBody,
  buildResponsesInputItems,
  emitResponsesCheckpoint,
  fingerprintResponsesBody,
  parseResponsesEvents,
  parseResponsesSSEFrames,
  strictExtensionTail,
  type ResponsesCompletionMeta,
  type ResponsesInputItem,
} from "./openai-responses-wire"
import type { ResponsesContinuationStore } from "./responses-continuation-store"
import { withStreamTimeout } from "./stream-timeout"
import type { LlmTransportId } from "./target-metadata"
import type { StreamEvent, StreamInput } from "./types"

export type ResponsesFetchLike = (url: string, init?: RequestInit) => Promise<Response>

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

export const buildResponsesFirstChunkTimeoutError = (
  ms: number,
  provider: LLMProvider,
): LLMError =>
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
  const fullBody = buildResponsesBody(args.input, args.model, {
    inputItems: fullInputItems,
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    store: false,
  })
  const requestFingerprint = fingerprintResponsesBody(fullBody)
  if (
    routeKey === undefined ||
    args.continuationStore === undefined
  ) {
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
  if (
    previous === null ||
    previous.responseId === ""
  ) {
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
            buildResponsesFirstChunkTimeoutError(
              config.timeoutMs.firstChunkMs,
              config.provider,
            ),
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
      const text = await res.text().catch(() => "")
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

    const outputItems: ResponsesInputItem[] = []
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
