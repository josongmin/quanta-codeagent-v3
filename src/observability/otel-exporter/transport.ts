/**
 * `@/observability/otel-exporter/transport` — the OTLP transport half of the
 * exporter: resolve headers, POST one envelope, classify the outcome, and the
 * per-stream buffer drain built on top of it.
 *
 * Split out of `otel-exporter.ts` when the FINAL-flush outcome landed: the
 * transport factory was already 146 lines against the 150-line god-FUNCTION
 * ceiling, and the host file sat at 877 against the 900-999 cohort band whose
 * ceiling is full. The seam is the same one `retry-policy.ts` uses — nothing
 * here knows about tracers, sinks or env wiring; it owns buffers, gates and
 * `fetch`.
 *
 * The flush logic is the reason this is worth naming. It takes the whole buffer
 * out BY IDENTITY and clears it, so records arriving during the awaited POST
 * land in the now-empty buffer; on failure the unsent snapshot is re-queued
 * AHEAD of the newcomers and the cap re-applied. Indexing by front-count
 * instead would drop unsent records beyond the documented drop-oldest policy
 * whenever `boundedPush` evicted from the front mid-flush (audit R1 D-F1).
 */

import { errMessage } from "@/shared"
import type { ExportMetric, ExportSpan } from "./otlp-encode"
import { serializeMetrics, serializeSpans } from "./otlp-encode"
import { backoffMs, classifyPostStatus, type PostOutcome, parseRetryAfterMs } from "./retry-policy"

// Module-private. The split promoted these to exports; nothing outside this
// file has ever read them, and an export is a promise to a caller that does
// not exist.
const TRACES_PATH = "/v1/traces"
const METRICS_PATH = "/v1/metrics"

/** The slice of `OtelExporterOpts` the transport reads. Declared structurally
 *  rather than imported so this module does not depend back on its host (the
 *  host passes its whole opts object, which satisfies this). */
export interface OtlpTransportOpts {
  readonly headers?: Readonly<Record<string, string>>
  readonly getHeaders?: () => Promise<Readonly<Record<string, string>>>
  readonly now?: () => number
  /** Hard upper bound for one collector POST. A final flush must never keep a
   * completed CLI process alive forever when the collector stalls. */
  readonly postTimeoutMs?: number
}

const DEFAULT_POST_TIMEOUT_MS = 10_000

/**
 * The classified POST.
 *
 * A clean seam: this half needs only the endpoint, the fetch impl, the header
 * resolver and a warn sink — none of the buffers, gates or drop counters the
 * flush half owns.
 */
const makeClassifiedPost = (
  opts: OtlpTransportOpts,
  deps: {
    readonly fetchImpl: typeof fetch
    readonly endpoint: string
    readonly safeWarn: (message: string) => void
  },
): ((path: string, body: unknown) => Promise<PostOutcome>) => {
  const { fetchImpl, endpoint, safeWarn } = deps
  const postTimeoutMs =
    Number.isFinite(opts.postTimeoutMs) && (opts.postTimeoutMs ?? 0) > 0
      ? Math.floor(opts.postTimeoutMs as number)
      : DEFAULT_POST_TIMEOUT_MS
  const resolveHeaders = async (): Promise<Record<string, string>> => {
    const staticHeaders = { ...(opts.headers ?? {}) }
    if (opts.getHeaders === undefined) return staticHeaders
    try {
      const dynamic = await opts.getHeaders()
      return { ...staticHeaders, ...dynamic }
    } catch (e) {
      safeWarn(`[otel-exporter] getHeaders: ${errMessage(e)} (falling back to static headers)`)
      return staticHeaders
    }
  }

  /** POST one envelope to `${endpoint}${path}`, CLASSIFIED.
   *
   *  Three outcomes, not two — see {@link classifyPostStatus}. The caller
   *  clears the buffer on `ok`, discards the batch on `drop`, and re-queues +
   *  backs off on `retry`. A serialization failure is a `drop`: the same
   *  records will fail to stringify on every future flush, so re-queueing them
   *  is the same permanent blackhole as retrying a 400, one layer up. */
  const post = async (path: string, body: unknown): Promise<PostOutcome> => {
    let serialized: string
    try {
      serialized = JSON.stringify(body)
    } catch (e) {
      return { kind: "drop", reason: `serialize failed (${errMessage(e)})` }
    }
    const dynamicHeaders = await resolveHeaders()
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let res: Response
      try {
        const expires = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`OTLP POST timed out after ${postTimeoutMs}ms`)),
            postTimeoutMs,
          )
        })
        res = await Promise.race([
          fetchImpl(`${endpoint}${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...dynamicHeaders,
            },
            body: serialized,
          }),
          expires,
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
      if (res.ok) return { kind: "ok" }
      if (classifyPostStatus(res.status) === "drop") {
        return { kind: "drop", reason: `HTTP ${res.status}` }
      }
      return {
        kind: "retry",
        retryAfterMs: parseRetryAfterMs(res.headers?.get?.("retry-after")),
        reason: `HTTP ${res.status}`,
      }
      // A transport throw (DNS, ECONNREFUSED, TLS, abort) is indistinguishable
      // from "the collector is restarting" — always retryable. It does NOT warn
      // here: the caller's `onRetry` logs every retry class through ONE latched
      // line, so this path is neither silent nor a per-attempt firehose.
    } catch (e) {
      return { kind: "retry", retryAfterMs: undefined, reason: errMessage(e) }
    }
  }
  return post
}

/** Per-stream mutable state. `attempts` is CONSECUTIVE retryable failures
 *  (reset by a success or a drop); `notBeforeMs` is the wall-clock instant the
 *  next attempt is allowed. Spans and metrics back off independently — a wedged
 *  metrics pipeline must not stall traces. The counters are surfaced in the
 *  warn lines so every failure class is COUNTED and visible, never silent, and
 *  `retryWarned` is the per-STREAK latch that keeps "visible" from becoming a
 *  firehose. */
interface StreamState {
  attempts: number
  notBeforeMs: number
  dropped: number
  retried: number
  /** Records thrown away because the FINAL (forced) flush failed. */
  lostAtExit: number
  retryWarned: boolean
}

const newStreamState = (): StreamState => ({
  attempts: 0,
  notBeforeMs: 0,
  dropped: 0,
  retried: 0,
  lostAtExit: 0,
  retryWarned: false,
})

/**
 * One drain, shared by both streams (they differ only in buffer, path,
 * serializer, label and state).
 *
 * `force` bypasses the backoff gate — used by `teardown`, where a skipped
 * attempt is not "we'll get it next tick" but permanent loss at exit. It also
 * changes what a retryable failure MEANS, which is the whole point of
 * {@link onFinalLoss} below.
 */
const makeFlush = <T>(args: {
  readonly stream: "span" | "metric"
  readonly buffer: T[]
  readonly path: string
  readonly serialize: (batch: ReadonlyArray<T>) => Record<string, unknown>
  readonly state: StreamState
  readonly maxBufferSize: number
  readonly overflowWarned: { span: boolean; metric: boolean }
  readonly now: () => number
  readonly post: (path: string, body: unknown) => Promise<PostOutcome>
  readonly safeWarn: (message: string) => void
}): ((force?: boolean) => Promise<void>) => {
  const { stream, buffer, path, serialize, state, maxBufferSize, overflowWarned } = args
  const { now, post, safeWarn } = args

  /** Landed. Clear the backoff and re-arm the overflow warn latch. */
  const onOk = (): void => {
    state.attempts = 0
    state.notBeforeMs = 0
    state.retryWarned = false
    if (buffer.length < maxBufferSize) overflowWarned[stream] = false
  }

  /** PERMANENT. Discard the batch rather than re-queue it: re-queueing is
   *  what turned one rejected batch into a blackhole for every later record.
   *  Loud, counted, and bounded — the pipeline keeps running. */
  const onDrop = (count: number, reason: string): void => {
    state.attempts = 0
    state.notBeforeMs = 0
    state.retryWarned = false
    state.dropped += count
    safeWarn(
      `[otel-exporter] POST ${path} → ${reason} — permanent, dropping ${count} ${stream}(s); ${state.dropped} dropped total`,
    )
  }

  /** Re-queue the unsent snapshot ahead of any newcomers, re-apply the cap
   *  (drop-oldest) so the buffer cannot grow unbounded, and arm the backoff
   *  so repeated flushes do not hammer an unhealthy collector. */
  const onRetry = (snapshot: T[], retryAfterMs: number | undefined, reason: string): void => {
    state.attempts += 1
    const delayMs = retryAfterMs ?? backoffMs(state.attempts)
    state.notBeforeMs = now() + delayMs
    state.retried += snapshot.length
    buffer.unshift(...snapshot)
    if (buffer.length > maxBufferSize) {
      buffer.splice(0, buffer.length - maxBufferSize)
    }
    if (state.retryWarned) return
    state.retryWarned = true
    safeWarn(
      `[otel-exporter] POST ${path} → ${reason} — retryable, re-queued ${snapshot.length} ${stream}(s), next attempt in ${delayMs}ms; ${state.retried} retried total (repeats on this streak are not logged)`,
    )
  }

  /** FINAL. The same retryable outcome, but on a FORCED flush — `teardown` has
   *  already cleared the interval and nothing will flush again, so "retryable"
   *  here is not deferred delivery: these records are GONE. Re-queueing them
   *  would put them in a buffer nothing drains, and the deferral line would
   *  promise an attempt no timer will ever run — the exact half of the loss
   *  `force` exists to prevent, reported as if it had been prevented.
   *
   *  Deliberately OUTSIDE the per-streak latch: at teardown that latch is
   *  normally ALREADY armed by the outage still in progress, so routing this
   *  through `onRetry` makes the loss not merely mislabelled but SILENT. */
  const onFinalLoss = (count: number, reason: string): void => {
    state.lostAtExit += count
    safeWarn(
      `[otel-exporter] POST ${path} → ${reason} — FINAL flush at teardown failed: DISCARDING ${count} ${stream}(s) (${state.lostAtExit} lost at exit); the exporter is shutting down, so there is no further attempt`,
    )
  }

  return async (force = false): Promise<void> => {
    if (buffer.length === 0) return
    // Backed off — leave the buffer intact and let a later flush carry it.
    if (!force && now() < state.notBeforeMs) return
    // Take the whole buffer out by identity and clear it. Records that arrive
    // DURING the awaited POST land in the now-empty buffer; the success path
    // must never index by front-count, because boundedPush may have evicted the
    // in-flight entries from the front mid-flush — that would drop UNSENT
    // records beyond the documented drop-oldest overflow policy (audit R1 D-F1).
    const snapshot = buffer.splice(0, buffer.length)
    const outcome = await post(path, serialize(snapshot))
    if (outcome.kind === "ok") return onOk()
    if (outcome.kind === "drop") return onDrop(snapshot.length, outcome.reason)
    if (force) return onFinalLoss(snapshot.length, outcome.reason)
    return onRetry(snapshot, outcome.retryAfterMs, outcome.reason)
  }
}

export const buildOtlpTransport = (
  opts: OtlpTransportOpts,
  ctx: {
    readonly fetchImpl: typeof fetch
    readonly endpoint: string
    readonly serviceName: string
    readonly runId: string | undefined
    readonly maxBufferSize: number
    readonly spanBuffer: ExportSpan[]
    readonly metricBuffer: ExportMetric[]
    readonly overflowWarned: { span: boolean; metric: boolean }
    readonly safeWarn: (message: string) => void
  },
): {
  readonly flushSpans: (force?: boolean) => Promise<void>
  readonly flushMetrics: (force?: boolean) => Promise<void>
} => {
  const { fetchImpl, endpoint, serviceName, runId, maxBufferSize } = ctx
  const { spanBuffer, metricBuffer, overflowWarned, safeWarn } = ctx
  const post = makeClassifiedPost(opts, { fetchImpl, endpoint, safeWarn })
  const now = opts.now ?? Date.now
  const shared = { maxBufferSize, overflowWarned, now, post, safeWarn } as const

  const flushSpans = makeFlush({
    stream: "span",
    buffer: spanBuffer,
    path: TRACES_PATH,
    serialize: (batch) => serializeSpans(batch, serviceName, runId),
    state: newStreamState(),
    ...shared,
  })

  const flushMetrics = makeFlush({
    stream: "metric",
    buffer: metricBuffer,
    path: METRICS_PATH,
    serialize: (batch) => serializeMetrics(batch, serviceName, runId),
    state: newStreamState(),
    ...shared,
  })

  return { flushSpans, flushMetrics }
}
