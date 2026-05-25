/**
 * T1: LLM stream first-chunk + inter-chunk idle timeout wrapper.
 *
 * Why this exists: SDK transports give us only an HTTP-level timeout. A
 * provider that opens the response stream but then never (or stops) writing
 * SSE/WS frames leaves the consumer hung indefinitely. The observed bench
 * failure ("Hung-Stream Abort", gpt-4o-mini django run): 115 s of silence,
 * zero stream chunks, then a manual abort. The agent loop has
 * `MAX_TURN_STREAM_RETRIES = 3` but it only fires on THROWN errors — silence
 * is never an error, so retry never engaged.
 *
 * Fix shape: an `AsyncIterable` decorator that races each `next()` of the
 * raw stream against a deadline. Two independent budgets:
 *   - `firstChunkMs` until the FIRST yield (default 60 000 ms — reasoning
 *     models like o1 can legitimately take 30s+ before any token).
 *   - `idleMs` between subsequent yields (default 120 000 ms — long
 *     completions are OK, but no sane provider is silent for >2 minutes
 *     mid-response).
 *
 * On timeout we throw an {@link LLMError} with `kind:"stream_corrupt"`.
 * That kind ALREADY exists in our taxonomy ({@link LLMError}) and the
 * agent loop's `classifyLLMError` routes it through the same-turn retry
 * path (message contains "timeout" → `RETRYABLE_MARKERS` hit → retry with
 * backoff). We deliberately reuse `stream_corrupt` rather than mint a new
 * kind: invariant compatibility with all downstream policy.
 *
 * Abort wiring: the wrapper resolves the raw stream's OWN upstream abort
 * surface (`.controller.abort()` first, `.abort()` second) and uses that
 * instead of a disconnected local controller. On timeout or caller abort we
 * tear down the real provider request, and on early consumer stop we also
 * finalize the raw iterator via `iter.return?.()`.
 *
 * Pure decorator: zero behavioural change on a stream that yields within
 * budget (each `for await` step passes through verbatim). Only the
 * silence-hang failure mode is converted from "wait forever" into
 * "structured retryable error".
 */
import { LLMError, type LLMProvider } from "@/shared"

export interface StreamTimeoutOptions {
  /** Max ms to wait for the FIRST yielded chunk. */
  readonly firstChunkMs: number
  /** Max ms between subsequent yielded chunks (idle gap). */
  readonly idleMs: number
  /** Provider id, threaded into the thrown {@link LLMError} so downstream
   *  routing/triage sees a faithful `provider`. */
  readonly provider: LLMProvider
  /** Caller's abort signal. When it fires, the wrapper aborts the raw
   *  provider stream's own upstream cancellation surface too. */
  readonly signal?: AbortSignal
  /** Injectable for deterministic tests. Defaults to real timers. */
  readonly setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  /** ADR-0227 hook: invoked on EVERY yielded chunk (not on `done`, not
   *  on timeout). The spinner-stall detector consumes this to bump its
   *  per-correlation `lastEventMs`. Best-effort — exceptions are
   *  swallowed so a faulty detector NEVER breaks the stream. Omitted ⇒
   *  byte-identical to pre-slice behaviour. */
  readonly onChunk?: () => void
}

/** Defaults (also the env-knob baseline). Exported so tests + adapter
 *  construction both see the same numbers. */
export const DEFAULT_FIRST_CHUNK_MS = 60_000
export const DEFAULT_IDLE_MS = 120_000

/** Reason tag on the thrown error's message — kept stable so tests/probes can
 *  string-match without depending on the surrounding prose. */
type TimeoutReason = "first-chunk" | "idle"

const buildTimeoutError = (reason: TimeoutReason, ms: number, provider: LLMProvider): LLMError => {
  // Message includes "timeout" so `classifyLLMError` in `src/agent/retry.ts`
  // (which checks `RETRYABLE_MARKERS` for "timeout"/"timed out") routes this
  // through the existing same-turn retry path. Do NOT change this wording
  // without also extending the retry markers — the integration is by string.
  const message =
    reason === "first-chunk"
      ? `LLM stream first-chunk timeout after ${ms}ms (provider sent no data; timed out)`
      : `LLM stream idle timeout after ${ms}ms (no data between chunks; timed out)`
  return new LLMError(message, {
    kind: "stream_corrupt",
    provider,
    cause: new Error(`${reason} timeout @${ms}ms`),
  })
}

export interface StreamTimeoutAbortHandle {
  abort(reason?: unknown): void
  readonly signal?: AbortSignal
}

const isAbortSignalLike = (value: unknown): value is AbortSignal =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { aborted?: unknown }).aborted === "boolean"

const isAbortControllerLike = (
  value: unknown,
): value is { abort(reason?: unknown): void; readonly signal: AbortSignal } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { abort?: unknown }).abort === "function" &&
  isAbortSignalLike((value as { signal?: unknown }).signal)

const resolveAbortHandle = <T>(raw: AsyncIterable<T>): StreamTimeoutAbortHandle | null => {
  const maybeAbortable = raw as { controller?: unknown; abort?: unknown }
  const controller = maybeAbortable.controller
  if (isAbortControllerLike(controller)) {
    return {
      abort: (reason?: unknown) => controller.abort(reason),
      signal: controller.signal,
    }
  }
  if (typeof maybeAbortable.abort === "function") {
    return { abort: maybeAbortable.abort.bind(raw) as (reason?: unknown) => void }
  }
  return null
}

const abortHandle = (handle: StreamTimeoutAbortHandle | null, reason?: unknown): void => {
  if (handle === null) return
  try {
    handle.abort(reason)
  } catch {
    // Best-effort teardown only: never let provider-specific abort-surface
    // quirks mask the primary timeout or cancellation path.
  }
}

/** ADR-0227: invoke the optional onChunk hook, swallowing any error so a
 *  faulty spinner-stall detector never poisons the live stream. Extracted
 *  as a top-level helper to keep the iterator body within the biome
 *  complexity cap. */
const notifyChunkArrival = (onChunk: (() => void) | undefined): void => {
  if (onChunk === undefined) return
  try {
    onChunk()
  } catch {
    // Intentionally silent — detector book-keeping must never break the
    // producer.
  }
}

const buildWrappedStream = <T>(
  raw: AsyncIterable<T>,
  opts: StreamTimeoutOptions,
  probe?: StreamTimeoutProbe,
): AsyncIterable<T> => {
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      const iter = raw[Symbol.asyncIterator]()
      const upstreamAbort = resolveAbortHandle(raw)
      probe?.onAbortHandle?.(upstreamAbort)
      let upstreamClosed = false
      let finishedNaturally = false

      const onCallerAbort = (): void => {
        abortHandle(upstreamAbort, opts.signal?.reason)
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          abortHandle(upstreamAbort, opts.signal.reason)
        } else {
          opts.signal.addEventListener("abort", onCallerAbort, { once: true })
        }
      }

      let isFirst = true
      try {
        for (;;) {
          const ms = isFirst ? opts.firstChunkMs : opts.idleMs
          const reason: TimeoutReason = isFirst ? "first-chunk" : "idle"

          let timerHandle: ReturnType<typeof setTimeout> | undefined
          const timeoutPromise = new Promise<{ readonly timedOut: true }>((resolve) => {
            timerHandle = setTimer(() => resolve({ timedOut: true as const }), ms)
          })
          const nextPromise = iter.next().then((r) => ({ timedOut: false as const, r }))

          // eslint-disable-next-line no-await-in-loop
          const winner = await Promise.race([nextPromise, timeoutPromise])
          if (timerHandle !== undefined) clearTimer(timerHandle)

          if (winner.timedOut) {
            const error = buildTimeoutError(reason, ms, opts.provider)
            abortHandle(upstreamAbort, error)
            try {
              await iter.return?.(undefined)
              upstreamClosed = true
            } catch {
              // Best-effort cleanup; never let a teardown error mask the
              // primary timeout that the caller actually needs to see.
            }
            throw error
          }

          const r = winner.r
          if (r.done) {
            finishedNaturally = true
            return
          }
          isFirst = false
          // ADR-0227: spinner-stall detector tick on every yielded chunk.
          notifyChunkArrival(opts.onChunk)
          yield r.value
        }
      } finally {
        if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort)
        if (!finishedNaturally && !upstreamClosed) {
          abortHandle(upstreamAbort, opts.signal?.reason)
          try {
            await iter.return?.(undefined)
          } catch {
            // Best-effort finalization only: consumer cancellation should not
            // surface a second teardown error after the stream is already done.
          }
        }
      }
    },
  }
}

/**
 * Wrap a raw stream with first-chunk and inter-chunk idle deadlines.
 * The returned `AsyncIterable` is single-use (matches the SDK's own
 * single-shot stream semantics — never re-iterate a model response).
 */
export const withStreamTimeout = <T>(
  raw: AsyncIterable<T>,
  opts: StreamTimeoutOptions,
): AsyncIterable<T> => buildWrappedStream(raw, opts)

/** Resolve effective options for an adapter: caller overrides win, env knobs
 *  next, defaults last. Read ONCE at adapter construction (T1 contract). */
export const resolveStreamTimeoutMs = (
  envFirstChunkMs: number | undefined,
  envIdleMs: number | undefined,
  override?: { firstChunkMs?: number; idleMs?: number },
): { firstChunkMs: number; idleMs: number } => ({
  firstChunkMs: override?.firstChunkMs ?? envFirstChunkMs ?? DEFAULT_FIRST_CHUNK_MS,
  idleMs: override?.idleMs ?? envIdleMs ?? DEFAULT_IDLE_MS,
})

/** Test seam: surface the resolved upstream abort handle so a unit test can
 *  verify timeout / caller-abort paths tear down the REAL provider stream,
 *  not a disconnected local controller. */
export interface StreamTimeoutProbe {
  /** Called on FIRST `next()` with the resolved upstream abort handle, or
   *  `null` when the raw stream exposes no abort surface. */
  onAbortHandle?: (handle: StreamTimeoutAbortHandle | null) => void
}

/** Variant of {@link withStreamTimeout} that also surfaces the resolved
 *  upstream abort handle via a probe callback. Production code uses the plain
 *  export; tests use this. Behaviour is otherwise identical. */
export const withStreamTimeoutProbed = <T>(
  raw: AsyncIterable<T>,
  opts: StreamTimeoutOptions & StreamTimeoutProbe,
): AsyncIterable<T> => buildWrappedStream(raw, opts, opts)
