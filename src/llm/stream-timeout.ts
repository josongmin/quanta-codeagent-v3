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
 * On timeout we throw an {@link LLMError} with `kind:"network"`. A silent
 * provider stall is a TRANSIENT network-level failure, so it MUST route through
 * the same-turn retry path: `classifyLLMError`→`isRetryable` matches on the
 * `.kind` discriminator FIRST (`network` ∈ `RETRYABLE_KINDS`) before any message
 * scan, so `decideOnStreamError` backs off + retries (bounded by
 * `MAX_TURN_STREAM_RETRIES`; a pathological content-less retry loop is capped
 * separately by the empty-stream circuit breaker). The message still contains
 * "timeout" as defense-in-depth for the `kind:"unknown"` marker fallback.
 *
 * jun-26 FIX: this previously used `kind:"stream_corrupt"`, which the kind-first
 * `isRetryable` refactor had since moved into `FATAL_KINDS` — so a timeout was
 * classified FATAL and the turn died on the FIRST stall with zero retries,
 * silently killing the retry contract this decorator exists to provide.
 * `stream_corrupt` is now reserved for genuine SDK shape-drift (correctly fatal).
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
  // `kind:"network"` is the retry contract: `isRetryable` matches it on the
  // `.kind` discriminator (∈ RETRYABLE_KINDS) BEFORE any message scan, so a
  // transient stall retries with backoff. The "timeout" wording is kept as a
  // defense-in-depth marker for the `kind:"unknown"` fallback only — the primary
  // route is now the kind, NOT the string.
  const message =
    reason === "first-chunk"
      ? `LLM stream first-chunk timeout after ${ms}ms (provider sent no data; timed out)`
      : `LLM stream idle timeout after ${ms}ms (no data between chunks; timed out)`
  return new LLMError(message, {
    kind: "network",
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

/** Wire the caller's `AbortSignal` to the raw stream's OWN upstream abort
 *  surface and hand back the detach. Its own unit because it is a three-state
 *  decision (no signal / already aborted / listen) whose teardown half lives in
 *  a `finally` far below — keeping the add and the remove adjacent is what
 *  makes the symmetry checkable at a glance.
 *
 *  The returned detach is called UNCONDITIONALLY by the caller, exactly as
 *  before: `removeEventListener` for a listener that was never added (the
 *  already-aborted branch) is a documented no-op. */
const wireCallerAbort = (
  signal: AbortSignal | undefined,
  upstream: StreamTimeoutAbortHandle | null,
): (() => void) => {
  if (!signal) return () => {}
  const onCallerAbort = (): void => {
    abortHandle(upstream, signal.reason)
  }
  if (signal.aborted) {
    abortHandle(upstream, signal.reason)
  } else {
    signal.addEventListener("abort", onCallerAbort, { once: true })
  }
  return () => signal.removeEventListener("abort", onCallerAbort)
}

/** Which of the two INDEPENDENT budgets applies to this step. A unit so the
 *  `ms` and the `reason` tag are chosen by ONE predicate and can never
 *  disagree (a mismatched pair would report an "idle" timeout against the
 *  first-chunk budget). */
const deadlineFor = (
  opts: StreamTimeoutOptions,
  isFirst: boolean,
): { readonly ms: number; readonly reason: TimeoutReason } =>
  isFirst ? { ms: opts.firstChunkMs, reason: "first-chunk" } : { ms: opts.idleMs, reason: "idle" }

type DeadlineRace<T> =
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly r: IteratorResult<T> }

/** One step of the stream: `iter.next()` raced against a fresh deadline.
 *
 *  This is a unit because the timer's ENTIRE lifetime is here — armed inside
 *  the promise executor (so it is armed BEFORE `next()` is called, as it must
 *  be) and cleared in a `finally` so EVERY exit path clears it, the rejecting
 *  `next()` included. T01 (audit L6 C2): a bare `clearTimer` after the race was
 *  skipped on a rejecting stream, accumulating one `ms`-length `setTimeout`
 *  handle per fast reject and pinning the event loop.
 *
 *  When the DEADLINE wins, the abandoned `iter.next()` is still pending; if the
 *  torn-down stream later REJECTS it, that rejection has no handler → an
 *  `unhandledRejection` that can crash the process. The no-op catch attached
 *  here swallows the late settle (the timeout error the caller throws is the
 *  one that matters). jun-26 SE-audit. */
const raceNextAgainstDeadline = async <T>(
  iter: AsyncIterator<T>,
  ms: number,
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void,
): Promise<DeadlineRace<T>> => {
  let timerHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<{ readonly timedOut: true }>((resolve) => {
    timerHandle = setTimer(() => resolve({ timedOut: true as const }), ms)
  })
  const nextPromise = iter.next().then((r) => ({ timedOut: false as const, r }))
  let winner: DeadlineRace<T>
  try {
    winner = await Promise.race([nextPromise, timeoutPromise])
  } finally {
    if (timerHandle !== undefined) clearTimer(timerHandle)
  }
  if (winner.timedOut) void nextPromise.catch(() => {})
  return winner
}

/** Deadline-won teardown: build the error, abort the real upstream request,
 *  and finalize the raw iterator.
 *
 *  It returns `upstreamClosed` instead of throwing so the QUIRK is preserved
 *  verbatim: only a SUCCESSFUL `iter.return()` marks the upstream closed. When
 *  `iter.return()` itself throws, the flag stays false and the outer `finally`
 *  deliberately aborts + finalizes a SECOND time. */
const tearDownAfterTimeout = async <T>(
  iter: AsyncIterator<T>,
  upstream: StreamTimeoutAbortHandle | null,
  reason: TimeoutReason,
  ms: number,
  provider: LLMProvider,
): Promise<{ readonly error: LLMError; readonly upstreamClosed: boolean }> => {
  const error = buildTimeoutError(reason, ms, provider)
  abortHandle(upstream, error)
  try {
    await iter.return?.(undefined)
    return { error, upstreamClosed: true }
  } catch {
    // Best-effort cleanup; never let a teardown error mask the primary timeout
    // that the caller actually needs to see.
    return { error, upstreamClosed: false }
  }
}

/** Finalization for a stream the consumer walked away from — an early `break`,
 *  a throw in the consumer body, or a timeout whose own teardown failed. A
 *  unit because it is the exact mirror of {@link tearDownAfterTimeout}'s tail
 *  with NO error to report: consumer cancellation must not surface a second
 *  teardown error after the stream is already done. */
const finalizeAbandonedStream = async <T>(
  iter: AsyncIterator<T>,
  upstream: StreamTimeoutAbortHandle | null,
  reason: unknown,
): Promise<void> => {
  abortHandle(upstream, reason)
  try {
    await iter.return?.(undefined)
  } catch {
    // Best-effort finalization only.
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
      const detachCallerAbort = wireCallerAbort(opts.signal, upstreamAbort)

      let isFirst = true
      try {
        for (;;) {
          const { ms, reason } = deadlineFor(opts, isFirst)
          // eslint-disable-next-line no-await-in-loop
          const winner = await raceNextAgainstDeadline(iter, ms, setTimer, clearTimer)

          if (winner.timedOut) {
            // eslint-disable-next-line no-await-in-loop
            const failed = await tearDownAfterTimeout(
              iter,
              upstreamAbort,
              reason,
              ms,
              opts.provider,
            )
            upstreamClosed = failed.upstreamClosed
            throw failed.error
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
        detachCallerAbort()
        if (!finishedNaturally && !upstreamClosed) {
          await finalizeAbandonedStream(iter, upstreamAbort, opts.signal?.reason)
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
