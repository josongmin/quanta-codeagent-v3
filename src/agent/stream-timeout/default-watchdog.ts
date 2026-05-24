/**
 * ADR-0200 — Default {@link StreamWatchdog} implementation.
 *
 * `Promise.race(it.next(), idleTimeout)` per iteration. Snooze polls at
 * 50ms granularity. AbortSignal checked at the top of every iteration
 * AND races the idle wait so a mid-pause cancel surfaces immediately.
 *
 * Plane-clean: imports `./port`, `./types` only — NO sibling modules
 * outside this slice.
 */

import type { StreamWatchdog } from "./port"
import {
  StreamAbortError,
  StreamIdleError,
  StreamTotalError,
  type TimeoutAction,
  type TimeoutPolicy,
} from "./types"

export interface DefaultWatchdogOpts {
  /** Injection seam for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Snooze poll interval ms. Defaults to 50. Tests inject a smaller
   *  value to keep wall-clock low. */
  readonly snoozePollMs?: number
}

const DEFAULT_SNOOZE_POLL_MS = 50

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StreamAbortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new StreamAbortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

/** Park while the snooze controller reports paused. Polls at `pollMs`
 *  granularity; `sleep()` rejects with StreamAbortError on signal so a
 *  mid-snooze cancel surfaces immediately. */
const parkWhileSnoozed = async (
  isPaused: (() => boolean) | undefined,
  pollMs: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (isPaused === undefined) return
  while (isPaused() === true) {
    if (signal?.aborted === true) throw new StreamAbortError()
    await sleep(pollMs, signal)
  }
}

/** Race the pending pull against an idle timeout + the external abort
 *  signal. Returns the iterator result on success. Caller drops the
 *  pending promise from its slot when this resolves. */
const raceIdle = async <T>(
  pending: Promise<IteratorResult<T>>,
  idleMs: number,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new StreamIdleError(idleMs)), idleMs)
    if (signal !== undefined) {
      onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        rej(new StreamAbortError())
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([pending, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort)
    }
  }
}

/** Convert a raw idle/abort error into the right outcome under the
 *  configured action policy. Returns `"degrade"` when the caller should
 *  return `done` instead of rethrowing. */
const reactToError = (e: unknown, action: TimeoutAction): "rethrow" | "degrade" => {
  if (e instanceof StreamIdleError && action === "degrade") return "degrade"
  return "rethrow"
}

/** Per-iteration step. Returns `"continue"` to keep looping, `"return"`
 *  to terminate the generator gracefully, or yields the value via the
 *  out-param. Pulling this out of the async-iterator body reduces the
 *  cognitive-complexity budget to within the biome cap. */
type StepResult<T> =
  | { kind: "value"; value: T }
  | { kind: "return" }
  | { kind: "throw"; err: unknown }

const pullOne = async <T>(
  pending: Promise<IteratorResult<T>>,
  idleMs: number | undefined,
  signal: AbortSignal | undefined,
  action: TimeoutAction,
): Promise<StepResult<T>> => {
  let res: IteratorResult<T>
  try {
    res = idleMs !== undefined ? await raceIdle(pending, idleMs, signal) : await pending
  } catch (e) {
    if (reactToError(e, action) === "degrade") return { kind: "return" }
    return { kind: "throw", err: e }
  }
  if (res.done === true) return { kind: "return" }
  return { kind: "value", value: res.value }
}

const closeIterator = async <T>(it: AsyncIterator<T>): Promise<void> => {
  if (typeof it.return !== "function") return
  try {
    await it.return()
  } catch {
    // ignore — iterator already torn down.
  }
}

/** Check the post-yield total wall-clock cap. Returns `"continue"` to
 *  proceed, `"return"` to terminate gracefully (degrade), or throws when
 *  policy is non-degrade. Pure — no IO. */
const checkTotal = (
  startedAt: number,
  now: () => number,
  totalMs: number | undefined,
  action: TimeoutAction,
): "continue" | "return" => {
  if (totalMs === undefined || now() - startedAt <= totalMs) return "continue"
  if (action === "degrade") return "return"
  throw new StreamTotalError(totalMs)
}

interface WrapCtx<T> {
  readonly it: AsyncIterator<T>
  readonly startedAt: number
  readonly idleMs: number | undefined
  readonly totalMs: number | undefined
  readonly action: TimeoutAction
  readonly signal: AbortSignal | undefined
  readonly isPaused: (() => boolean) | undefined
  readonly snoozePollMs: number
  readonly now: () => number
}

/** One iteration: abort check → snooze park → pull → check total. The
 *  generator passes its `pending` slot in by ref so it persists across
 *  iterations. Returns either a value to yield, a terminate signal, or
 *  throws on a non-degrade timeout. */
const iterateOnce = async <T>(
  ctx: WrapCtx<T>,
  pendingRef: { current: Promise<IteratorResult<T>> | null },
): Promise<{ kind: "yield"; value: T } | { kind: "return" }> => {
  if (ctx.signal?.aborted === true) throw new StreamAbortError()
  await parkWhileSnoozed(ctx.isPaused, ctx.snoozePollMs, ctx.signal)
  if (pendingRef.current === null) pendingRef.current = ctx.it.next()
  const step = await pullOne(pendingRef.current, ctx.idleMs, ctx.signal, ctx.action)
  pendingRef.current = null
  if (step.kind === "return") return { kind: "return" }
  if (step.kind === "throw") throw step.err
  // Total cap checked AFTER consuming the value (matches HELL-ST-06).
  // Returned-value lives in the closure; total decision returns control
  // direction to the generator.
  return { kind: "yield", value: step.value }
}

export const createDefaultWatchdog = (opts?: DefaultWatchdogOpts): StreamWatchdog => {
  const now = opts?.now ?? Date.now
  const snoozePollMs = opts?.snoozePollMs ?? DEFAULT_SNOOZE_POLL_MS

  return {
    wrap<T>(src: AsyncIterable<T>, policy?: TimeoutPolicy, signal?: AbortSignal): AsyncIterable<T> {
      const idleMs = policy?.idleMs
      const totalMs = policy?.totalMs
      // Pass-through when neither axis active.
      if (idleMs === undefined && totalMs === undefined) return src
      const action: TimeoutAction = policy?.action ?? "abort"
      const isPaused = policy?.snooze?.isPaused.bind(policy.snooze)

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<T> {
          const it = src[Symbol.asyncIterator]()
          const startedAt = now()
          const ctx: WrapCtx<T> = {
            it,
            startedAt,
            idleMs,
            totalMs,
            action,
            signal,
            isPaused,
            snoozePollMs,
            now,
          }
          const pendingRef: { current: Promise<IteratorResult<T>> | null } = { current: null }
          try {
            while (true) {
              const step = await iterateOnce(ctx, pendingRef)
              if (step.kind === "return") return
              yield step.value
              if (checkTotal(startedAt, now, totalMs, action) === "return") return
            }
          } finally {
            if (pendingRef.current !== null) pendingRef.current.catch(() => undefined)
            await closeIterator(it)
          }
        },
      }
    },
  }
}
