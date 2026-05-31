/**
 * ── No-throw listener / observer dispatcher (T07 — May-31 bugbash) ───────────
 *
 * ONE shared primitive for "fire a best-effort host callback / notify a fan-out
 * of sibling listeners, and NEVER let one throwing listener abort the primary
 * delivery or poison its siblings."
 *
 * Before this module each boundary open-coded its own isolation:
 *   - `notifyChunkArrival` in `stream-timeout.ts` / `openai-responses-wire.ts`
 *     wrapped exactly ONE callback in `try { … } catch {}`, but the adjacent
 *     `onReasoning` / `onOutputItemDone` / `onCompleted` calls were left bare
 *     (audit L6 H1 — a throwing checkpoint/observability sink propagated out of
 *     `parseResponsesEvents`, corrupting the toolCalls map + continuation store).
 *   - the realtime adapter's inbound fan-out ran `for (const h of snapshot) h(msg)`
 *     with no guard, so the FIRST throwing subscriber starved every later one
 *     (audit L6 H8 — violates the documented sibling-isolation contract that
 *     `event-bridge.ts` / `ws-adapter.ts` already honour).
 *
 * The contract this module pins down:
 *   - `dispatchNoThrow(fn, ...args)` — invoke a single best-effort callback,
 *     swallowing any throw. Returns `true` when it ran clean, `false` when it
 *     threw (so a caller MAY route the error to an observability hook without
 *     ever re-throwing). A `undefined` callback is a clean no-op (`true`).
 *   - `notifyAllNoThrow(listeners, onError, ...args)` — invoke EVERY listener in
 *     order, isolating each from the others; a throwing listener cannot prevent
 *     the rest from receiving the event. Returns the count that threw.
 *   - both accept an optional `onError(err)` sink (itself dispatched no-throw)
 *     so a site that WANTS operator visibility keeps it without re-introducing
 *     a bare `try/catch` at the call site.
 *
 * HONESTY RULE: this is for BEST-EFFORT side-channels (observers, spinner-stall
 * ticks, checkpoint sinks, inbound subscribers). It is NOT for primary delivery
 * — a function whose throw the caller MUST observe (the actual stream `next()`,
 * the actual tool-input parse) does not go through here.
 *
 * Pure + dependency-free: no timers, no globals, no I/O. Importable from every
 * slice (shared leaf) so realtime, stream, and llm consume ONE dispatcher
 * instead of three divergent inline copies.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Optional observability sink for a swallowed listener error. Dispatched
 *  no-throw itself, so a faulty sink can never re-introduce the very failure
 *  this module exists to contain. */
export type NoThrowErrorSink = (error: unknown) => void

const routeError = (sink: NoThrowErrorSink | undefined, error: unknown): void => {
  if (sink === undefined) return
  try {
    sink(error)
  } catch {
    // A throwing error-sink must not escalate past the dispatcher. There is
    // deliberately no second-order sink — operator visibility is best-effort.
  }
}

/**
 * Invoke a single best-effort callback, swallowing any throw. Returns `true`
 * when the callback ran without throwing (or was `undefined`), `false` when it
 * threw. The optional `onError` sink receives the thrown value (dispatched
 * no-throw) for operator visibility.
 *
 * Replaces the per-site `try { opts.onX?.(...) } catch {}` pattern with one
 * audited owner, so adding a new best-effort host callback can never silently
 * forget the guard (audit L6 H1 / cross-cutting theme 2).
 */
export const dispatchNoThrow = <A extends readonly unknown[]>(
  fn: ((...args: A) => void) | undefined,
  ...args: A
): boolean => dispatchNoThrowWith(fn, undefined, ...args)

/** {@link dispatchNoThrow} with an explicit error sink. Kept as a distinct
 *  export so the common (sink-less) call stays terse and the typed variadics
 *  resolve cleanly. */
export const dispatchNoThrowWith = <A extends readonly unknown[]>(
  fn: ((...args: A) => void) | undefined,
  onError: NoThrowErrorSink | undefined,
  ...args: A
): boolean => {
  if (fn === undefined) return true
  try {
    fn(...args)
    return true
  } catch (error) {
    routeError(onError, error)
    return false
  }
}

/**
 * Invoke EVERY listener in `listeners` order, isolating each from the others.
 * A throwing listener is swallowed (and routed to `onError` if supplied) so the
 * remaining listeners still receive the event — the FIRST throw can no longer
 * starve its siblings (audit L6 H8). Returns the number of listeners that threw
 * (0 when all ran clean).
 *
 * The caller is responsible for snapshotting the listener list if it can mutate
 * during iteration (the realtime adapter already `.slice()`s before calling).
 */
export const notifyAllNoThrow = <A extends readonly unknown[]>(
  listeners: Iterable<(...args: A) => void>,
  onError: NoThrowErrorSink | undefined,
  ...args: A
): number => {
  let threw = 0
  for (const listener of listeners) {
    if (!dispatchNoThrowWith(listener, onError, ...args)) threw += 1
  }
  return threw
}
