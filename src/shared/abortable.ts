/**
 * ── Boundary abort / deadline primitive (T01 — May-31 bugbash) ──────────────
 *
 * ONE shared toolkit for `AbortSignal` propagation across every I/O boundary.
 * Before this module each adapter open-coded its own throwaway controller,
 * one-off `if (signal?.aborted)` check, or per-adapter timeout wrapper — so a
 * cancelled eval / shadow-verify / STT / HTTP-SSE session resolved the caller
 * promise early while the underlying work ran to completion (audit L3 C-6/9/10,
 * L5 H-2/H-5/M-6/M-8/M-10, L6 C2, L9 H1/H3/H4/H11/H12).
 *
 * The contract this module pins down:
 *   - `throwIfAborted(signal)` — typed `AbortError` (never a bare `Error`).
 *   - `abortableSleep(ms, signal)` — a sleep that REJECTS promptly on abort and
 *     ALWAYS clears its timer + removes its listener (no leaked timer, no leaked
 *     listener) on every exit path.
 *   - `fetchWithDeadline(input, { signal, timeoutMs })` — fetch wired to BOTH a
 *     caller signal AND a deadline; the rejection reason is a typed
 *     {@link AbortError} whose `.reason` distinguishes `"timeout"` from
 *     `"abort"`; timers/listeners are cleaned up on settle.
 *   - `drainAbortable(stream, onChunk, { signal })` — read a web `ReadableStream`
 *     (or any async-iterable) to completion, honoring abort by cancelling the
 *     underlying reader (not merely stopping iteration) and clearing listeners.
 *
 * HONESTY RULE: when a boundary genuinely cannot be cancelled mid-flight (a
 * synchronous native call, a process we don't own), DO NOT pretend. Use
 * {@link throwIfAborted} as a pre-flight gate and document the gap — the
 * result/error path must say "cancellation observed at the boundary, the
 * already-started native op cannot be interrupted", never silently resolve.
 *
 * All helpers are dependency-injectable at the timer seam so unit tests drive
 * them without real time. No hidden globals.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** The reason an abortable operation was torn down.
 *  - `"abort"`   — the caller's `AbortSignal` fired.
 *  - `"timeout"` — the operation's own deadline elapsed. */
export type AbortReasonKind = "abort" | "timeout"

/** Typed cancellation error. `name === "AbortError"` so existing classifiers
 *  (`@/shared` `isAbortError`, the LLM `aborted` kind, Node's fetch) recognise
 *  it. The `.reason` field is the structured discriminator downstream policy
 *  branches on — it must NEVER be recovered by re-parsing `.message`. */
export class AbortError extends Error {
  readonly reason: AbortReasonKind
  /** Original `signal.reason` when the caller aborted with one (forensics).
   *  `override` because `Error` declares `cause` (ES2022 lib). */
  override readonly cause?: unknown

  constructor(reason: AbortReasonKind, message?: string, cause?: unknown) {
    super(message ?? (reason === "timeout" ? "operation timed out" : "operation aborted"))
    this.name = "AbortError"
    this.reason = reason
    if (cause !== undefined) this.cause = cause
  }
}

/** True iff `e` is an abort/timeout cancellation (ours OR a platform DOMException
 *  `AbortError` / `TimeoutError`). Lets call sites classify a cancellation at
 *  the boundary exactly once instead of string-matching messages. */
export const isAbort = (e: unknown): e is { name: string } => {
  if (typeof e !== "object" || e === null) return false
  const name = (e as { name?: unknown }).name
  return name === "AbortError" || name === "TimeoutError"
}

/** Map any thrown cancellation to a typed {@link AbortReasonKind}, or `null`
 *  when it is not a cancellation at all. A platform `TimeoutError` ⇒ `"timeout"`;
 *  our {@link AbortError} carries its own `.reason`; a bare DOMException
 *  `AbortError` ⇒ `"abort"`. */
export const abortReasonOf = (e: unknown): AbortReasonKind | null => {
  if (e instanceof AbortError) return e.reason
  if (typeof e !== "object" || e === null) return null
  const name = (e as { name?: unknown }).name
  if (name === "TimeoutError") return "timeout"
  if (name === "AbortError") return "abort"
  return null
}

/** Throw a typed {@link AbortError} if `signal` is already aborted. The single
 *  pre-flight gate every boundary uses instead of an ad-hoc
 *  `if (signal?.aborted) return …`. No-op when `signal` is absent or live. */
export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new AbortError("abort", undefined, signal.reason)
  }
}

/** Timer seam — overridable so tests drive sleeps/deadlines without real time. */
export interface TimerPort {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: TimerPort = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * Sleep `ms` milliseconds, rejecting PROMPTLY with a typed {@link AbortError}
 * if `signal` aborts first. On EVERY exit path (resolve, abort-reject) the
 * underlying timer is cleared and the abort listener removed — no leaked timer
 * keeps the event loop alive, no leaked listener accumulates on a long-lived
 * signal (the exact pair of leaks the audit's per-adapter `setTimeout` sleeps
 * had: L5 M-8 / L9 retry sleeps).
 */
export const abortableSleep = (
  ms: number,
  signal?: AbortSignal,
  timers: TimerPort = realTimers,
): Promise<void> => {
  if (signal?.aborted) {
    return Promise.reject(new AbortError("abort", undefined, signal.reason))
  }
  return new Promise<void>((resolve, reject) => {
    let handle: unknown
    const onAbort = (): void => {
      timers.clear(handle)
      reject(new AbortError("abort", undefined, signal?.reason))
    }
    handle = timers.set(() => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Subset of the WHATWG `fetch` we wire a deadline onto. The init's `signal`
 *  is OWNED by `fetchWithDeadline` (it composes caller-signal + deadline); a
 *  caller-supplied `signal` in `init` is ignored in favour of the `opts.signal`
 *  argument so there is exactly one cancellation owner. */
export type DeadlineFetchFn = (
  input: string | URL,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
) => Promise<Response>

export interface FetchWithDeadlineOpts {
  /** Caller cancellation. Composed with the deadline. */
  readonly signal?: AbortSignal
  /** Hard wall-clock budget in ms. `<= 0` / `undefined` ⇒ no deadline (only the
   *  caller signal can cancel). A positive value installs an internal timer. */
  readonly timeoutMs?: number
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: unknown
  /** `fetch` seam (test injection). Default = global `fetch`. */
  readonly fetchFn?: DeadlineFetchFn
  /** Timer seam (test injection). */
  readonly timers?: TimerPort
}

/**
 * `fetch` wired to BOTH a caller signal and a deadline. Returns the `Response`
 * on success; rejects with a typed {@link AbortError} (`.reason === "timeout"`
 * for the deadline, `"abort"` for the caller signal) when cancelled. The
 * internal deadline timer is ALWAYS cleared once the fetch settles (success OR
 * failure) so a fast-failing endpoint cannot leak `timeoutMs`-length timers
 * (the L9 H1 "exporter wedge" class).
 *
 * The underlying HTTP request is actually torn down — we hand `fetch` a real
 * composed `AbortSignal`, so a hung connection is severed, not merely
 * abandoned by the caller (the L9 H4/H12 "socket leak" class).
 */
export const fetchWithDeadline = async (
  input: string | URL,
  opts: FetchWithDeadlineOpts,
): Promise<Response> => {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as DeadlineFetchFn)
  const timers = opts.timers ?? realTimers
  throwIfAborted(opts.signal)

  const controller = new AbortController()
  let timedOut = false
  let timerHandle: unknown
  const onCallerAbort = (): void => controller.abort(opts.signal?.reason)

  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    timerHandle = timers.set(() => {
      timedOut = true
      controller.abort()
    }, opts.timeoutMs)
  }
  if (opts.signal !== undefined) {
    opts.signal.addEventListener("abort", onCallerAbort, { once: true })
  }

  const cleanup = (): void => {
    if (timerHandle !== undefined) timers.clear(timerHandle)
    if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onCallerAbort)
  }

  try {
    return await fetchFn(input, {
      ...(opts.method !== undefined ? { method: opts.method } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: controller.signal,
    })
  } catch (e) {
    // Re-map the underlying abort into our typed reason so the caller never has
    // to guess whether the deadline or the caller's signal fired.
    if (timedOut) throw new AbortError("timeout", `request exceeded ${opts.timeoutMs}ms`, e)
    if (opts.signal?.aborted) throw new AbortError("abort", undefined, opts.signal.reason)
    throw e
  } finally {
    cleanup()
  }
}

/** A web-stream reader subset — what {@link drainAbortable} needs. */
export interface AbortableReader<T> {
  read(): Promise<{ done: boolean; value?: T }>
  cancel?(reason?: unknown): Promise<void> | void
  releaseLock?(): void
}

/** A web `ReadableStream`-like source. */
export interface AbortableReadable<T> {
  getReader(): AbortableReader<T>
}

/**
 * Drain a web `ReadableStream` to completion, invoking `onChunk` per chunk.
 * Honors abort by CANCELLING the underlying reader (releasing the socket /
 * process pipe) — not merely stopping iteration while the producer keeps
 * filling an OS buffer (the L9 H3 "undrained stdout deadlock" class). The
 * abort listener is removed on every exit path.
 *
 * Rejects with a typed {@link AbortError} when the caller signal fires mid-drain.
 * Returns normally when the stream ends on its own.
 */
export const drainAbortable = async <T>(
  source: AbortableReadable<T> | null | undefined,
  onChunk: (chunk: T) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<void> => {
  if (source === null || source === undefined) return
  throwIfAborted(opts.signal)
  const reader = source.getReader()
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    void reader.cancel?.(opts.signal?.reason)
  }
  if (opts.signal !== undefined) {
    opts.signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) onChunk(value)
    }
    if (aborted) throw new AbortError("abort", undefined, opts.signal?.reason)
  } finally {
    if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort)
    reader.releaseLock?.()
  }
}
