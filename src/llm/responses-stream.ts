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
  type ResponsesOutputItemDone,
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
  /** Reasoning summary request (`QUANTA_REASONING_SUMMARY`, bool). Threaded into
   *  BOTH the full + resume-tail `buildResponsesBody` calls so the resume body
   *  carries the same `reasoning.summary` and the request fingerprint stays
   *  consistent. Default-OFF ⇒ byte-identical. Body-only knob. */
  readonly reasoningSummary?: boolean
  /** Reasoning summary verbosity level (`QUANTA_REASONING_SUMMARY_DETAIL`,
   *  `"auto" | "concise" | "detailed"`). Threaded into BOTH body builds so the
   *  resume-tail body is consistent with the full body. Only consulted when
   *  {@link reasoningSummary} is `true`. Omitted ⇒ `"auto"` (wire default). */
  readonly reasoningSummaryDetail?: "auto" | "concise" | "detailed"
  /** Reasoning output verbosity (`QUANTA_REASONING_VERBOSITY`,
   *  `low|medium|high`). Threaded into BOTH body builds as `text.verbosity`.
   *  Omitted / out-of-set ⇒ no `text` field (byte-identical). Body-only knob. */
  readonly reasoningVerbosity?: string
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

// jun-26: a first-chunk TIMEOUT is a transient stall, not SDK corruption — so
// `kind:"network"` (∈ RETRYABLE_KINDS) routes it through the same-turn retry path
// (the empty-stream breaker caps a pathological content-less retry loop). Was
// `stream_corrupt`, which the kind-first `isRetryable` treats as FATAL ⇒ the turn
// died on the first stall with zero retries. `stream_corrupt` stays for genuine
// shape-drift (e.g. the no-body case below).
export const buildResponsesFirstChunkTimeoutError = (ms: number, provider: LLMProvider): LLMError =>
  new LLMError(`LLM stream first-chunk timeout after ${ms}ms (provider sent no data; timed out)`, {
    kind: "network",
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

const buildCommonBodyOpts = (args: PrepareResponsesContinuationRequestArgs) => ({
  ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
  ...(args.serviceTier !== undefined ? { serviceTier: args.serviceTier } : {}),
  ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  ...(args.reasoningSummary === true ? { reasoningSummary: true as const } : {}),
  ...(args.reasoningSummaryDetail !== undefined
    ? { reasoningSummaryDetail: args.reasoningSummaryDetail }
    : {}),
  ...(args.reasoningVerbosity !== undefined ? { reasoningVerbosity: args.reasoningVerbosity } : {}),
})

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
    ...buildCommonBodyOpts(args),
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
      ...buildCommonBodyOpts(args),
      ...carryoverOpts,
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

/** jun-6 account-ratelimit-snapshot — best-effort success-path header capture
 *  (mirrors the Anthropic adapter's `.withResponse()` hook). Present ONLY when
 *  the loop wired the hook. A faulty quota consumer must never break the live
 *  stream. Absent ⇒ no call, byte-identical to pre-feature. */
const captureResponseHeaders = (res: Response, config: ResponsesStreamConfig): void => {
  if (config.input.onResponseHeaders === undefined) return
  try {
    config.input.onResponseHeaders((name) => res.headers.get(name))
  } catch {
    // swallow — header capture is non-essential observability.
  }
}

/** Throw the classified {@link LLMError} for a non-OK response (reads + logs the
 *  provider error body for the diagnostic). The bodyless-200 (`res.body === null`)
 *  check stays INLINE at the call site so TS narrows `res.body` for the parser. */
const assertResponsesResponseOk = async (
  res: Response,
  config: ResponsesStreamConfig,
): Promise<void> => {
  if (res.ok) return
  const text = await readBodyTextOrLog(res, config.provider)
  throw new LLMError(
    `${config.provider} responses request failed: ${res.status} ${res.statusText}` +
      (text ? ` — ${text.slice(0, 200)}` : ""),
    { kind: responsesStatusToKind(res.status), statusCode: res.status, provider: config.provider },
  )
}

/** jun-20 throttle-swallow guard: a 200 that streams ZERO content AND never
 *  completes is a silently-swallowed transport throttle, NOT a valid empty turn —
 *  reclassify as a RETRYABLE `rate_limit` so the loop's backoff spaces retries
 *  (else the agent fires the next request straight into the same window). Only
 *  the truly-empty prepare-only case (no content + no completion + a benign/absent
 *  terminal stop_reason) throws; a partial stream or an intentional content_filter/
 *  max_tokens terminator is left alone. */
const assertResponsesNonEmptyStreamOrThrow = (
  config: ResponsesStreamConfig,
  prepared: ResponsesPreparedRequest,
  state: {
    readonly sawContentEvent: boolean
    readonly completed: ResponsesCompletionMeta | null
    readonly terminalStopReason: string | undefined
  },
): void => {
  if (
    state.sawContentEvent ||
    state.completed !== null ||
    !(state.terminalStopReason === "end_turn" || state.terminalStopReason === undefined)
  ) {
    return
  }
  if (config.continuationStore !== undefined && prepared.routeKey !== undefined) {
    config.continuationStore.clear(prepared.routeKey)
  }
  throw new LLMError(
    `${config.provider} responses stream produced no content and no completion event ` +
      `(empty/truncated stream — likely transport throttle); retrying with backoff`,
    { kind: "rate_limit", provider: config.provider },
  )
}

/** H15 — persist THIS turn's captured reasoning for the next turn's re-emit.
 *  Default-OFF byte-identity: skipped unless carry-over is on AND a store is
 *  wired AND a routeKey resolved. `put` REPLACES (latest supersedes); an empty
 *  capture CLEARS so a no-reasoning turn does not re-feed a stale chain. */
const persistResponsesReasoningCarryover = (
  config: ResponsesStreamConfig,
  prepared: ResponsesPreparedRequest,
  capturedReasoning: readonly ResponsesInputItem[],
): void => {
  const store = config.reasoningCarryoverStore
  if (
    config.reasoningCarryover !== true ||
    store === undefined ||
    prepared.routeKey === undefined
  ) {
    return
  }
  if (capturedReasoning.length > 0) store.put(prepared.routeKey, capturedReasoning)
  else store.clear(prepared.routeKey)
}

/** Persist the continuation (prompt-cache resume) baseline for this route when
 *  the store is wired + resume is enabled + a responseId landed; clears the route
 *  otherwise. Terminal — no yields follow, so its early returns just end the
 *  persist (byte-identical to the inline block). */
const persistResponsesContinuation = (
  config: ResponsesStreamConfig,
  prepared: ResponsesPreparedRequest,
  completed: ResponsesCompletionMeta | null,
  outputItems: readonly ResponsesInputItem[],
  resumable: boolean,
): void => {
  const store = config.continuationStore
  if (store === undefined || !canPersistContinuation(prepared, store)) return
  const responseId =
    completed !== null && typeof completed.responseId === "string"
      ? completed.responseId
      : undefined
  if (typeof responseId !== "string" || responseId === "") {
    store.clear(prepared.routeKey)
    return
  }
  store.put({
    routeKey: prepared.routeKey,
    responseId,
    requestFingerprint: prepared.requestFingerprint,
    inputItems: prepared.fullInputItems,
    outputItems,
    resumable,
  })
}

/** Per-turn mutable accumulator the parser callbacks populate + the post-loop
 *  persisters read back. `outputItems` = normalized resume baseline; `captured
 *  reasoning` = H15 re-emittable items; `resumable` gated off by any reasoning /
 *  un-normalizable item; `completed` = the terminal meta. */
interface ResponsesStreamAccumulator {
  readonly outputItems: ResponsesInputItem[]
  readonly capturedReasoning: ResponsesInputItem[]
  resumable: boolean
  completed: ResponsesCompletionMeta | null
}

/** The accumulator + the three `parseResponsesEvents` callbacks that populate it.
 *  Extracted so the surface reads as a thin frame loop; the callback BODIES are
 *  byte-identical to the inline versions (H15 reasoning capture, output-item
 *  normalization + resume gating, on-checkpoint). */
const buildResponsesStreamAccumulator = (
  config: ResponsesStreamConfig,
): {
  readonly acc: ResponsesStreamAccumulator
  readonly callbacks: {
    readonly onCompleted: (meta: ResponsesCompletionMeta) => void
    readonly onOutputItemDone: (item: ResponsesOutputItemDone) => void
    readonly onReasoning: () => void
  }
} => {
  const acc: ResponsesStreamAccumulator = {
    outputItems: [],
    capturedReasoning: [],
    resumable: true,
    completed: null,
  }
  return {
    acc,
    callbacks: {
      onCompleted: (meta) => {
        acc.completed = meta
        if ((meta.usage?.reasoning ?? 0) > 0) acc.resumable = false
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
        // ORTHOGONAL to the resume/baseline path: a reasoning item still has
        // `normalized === null`, so resumability is unchanged.
        if (item.reasoningItem !== undefined) acc.capturedReasoning.push(item.reasoningItem)
        if (item.normalized === null) {
          acc.resumable = false
          return
        }
        acc.outputItems.push(item.normalized)
      },
      onReasoning: () => {
        acc.resumable = false
      },
    },
  }
}

/** The retry `reason` string for a rejected resume: `resume_rejected` when the
 *  status is on the disable-resume set (the server refused the resume), else
 *  `stale_previous_response`. */
const resumeRetryReason = (
  status: number,
  disableResumeOnStatuses: ReadonlySet<number> | undefined,
): "resume_rejected" | "stale_previous_response" =>
  disableResumeOnStatuses?.has(status) === true ? "resume_rejected" : "stale_previous_response"

/** Rebuild the prepared request as a FULL (non-resumed) retry after a resume was
 *  rejected: drop the resume linkage, use the full body/input, and stamp a
 *  `full_retry` continuation event. Byte-identical to the inline rebuild. */
const buildFullRetryPrepared = (
  prepared: ResponsesPreparedRequest,
  config: ResponsesStreamConfig,
  status: number,
): ResponsesPreparedRequest => ({
  body: prepared.fullBody,
  fullBody: prepared.fullBody,
  ...(prepared.routeKey !== undefined ? { routeKey: prepared.routeKey } : {}),
  ...(prepared.requestFingerprint !== undefined
    ? { requestFingerprint: prepared.requestFingerprint }
    : {}),
  ...(prepared.fullInputItems !== undefined ? { fullInputItems: prepared.fullInputItems } : {}),
  continuationEvent: continuationEvent({
    transportId: config.transportId,
    phase: "retry",
    mode: "full_retry",
    reason: resumeRetryReason(status, config.disableResumeOnStatuses),
    statusCode: status,
  }),
})

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
        reason: resumeRetryReason(res.status, disableResumeOnStatuses),
        statusCode: res.status,
      })
      prepared = buildFullRetryPrepared(prepared, config, res.status)
      res = await postBody(prepared.body)
    }

    await assertResponsesResponseOk(res, config)
    if (res.body === null) {
      throw new LLMError(`${config.provider} responses stream has no body`, {
        kind: "stream_corrupt",
        provider: config.provider,
      })
    }
    captureResponseHeaders(res, config)

    const { acc, callbacks } = buildResponsesStreamAccumulator(config)
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

    // jun-20 throttle-swallow fix — track whether ANY content event was yielded
    // (a `for await` instead of `yield*` so we observe the stream, not just relay
    // it). The prepare/continuation event was already yielded above (line ~447);
    // this counts CONTENT (text/tool/reasoning/completion) events only.
    let sawContentEvent = false
    // jun-20 audit fix — capture the TERMINAL stop_reason. A swallowed-throttle
    // empty stream terminates via the normal end (`stop_reason:"end_turn"`,
    // openai-responses-wire.ts:750); an INTENTIONAL early terminator
    // (`response.incomplete` → content_filter / max_tokens / error) carries a
    // DIFFERENT stop_reason and must NOT be reclassified as a retryable throttle.
    let terminalStopReason: string | undefined
    try {
      for await (const ev of parseResponsesEvents(guardedFrames, {
        provider: config.provider,
        fallbackModel: config.model,
        // H15 — pass the capture gate THROUGH to the wire. Default-OFF ⇒ omitted
        // (the wire's `onOutputItemDone` payload is the legacy 2-field shape and
        // `reasoningItem` is never surfaced ⇒ byte-identical).
        ...(config.reasoningCarryover === true ? { reasoningCarryover: true } : {}),
        ...callbacks,
      })) {
        // `message_stop` is the synthetic stream-terminator the parser emits even
        // for a 0-content stream — it is NOT content. Only a real content event
        // (text / tool_call / thinking / …) marks the turn as non-empty, so the
        // empty/truncated-throttle guard below fires on a prepare+stop-only stream.
        // We also remember its stop_reason so an intentional non-end_turn terminator
        // (content_filter / max_tokens) is excluded from the throttle reclassification.
        if (ev.type === "message_stop") terminalStopReason = ev.stop_reason
        else sawContentEvent = true
        yield ev
      }
    } catch (error) {
      if (config.continuationStore !== undefined && prepared.routeKey !== undefined) {
        config.continuationStore.clear(prepared.routeKey)
      }
      throw error
    }

    assertResponsesNonEmptyStreamOrThrow(config, prepared, {
      sawContentEvent,
      completed: acc.completed,
      terminalStopReason,
    })
    persistResponsesReasoningCarryover(config, prepared, acc.capturedReasoning)
    persistResponsesContinuation(config, prepared, acc.completed, acc.outputItems, acc.resumable)
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
