/**
 * Active-span async context (ADR-0186 — C1 delta).
 *
 * The typed `Tracer` port mints span IDENTITIES (`startSpan`) and scopes their
 * lifetime (`withSpan`), but until now nothing published "which span is active
 * for the current async call chain". Nested async callers (an LLM stream opened
 * inside a turn, a tool span opened inside an agent span) had no structural way
 * to discover their enclosing parent — they had to be handed the parent Span
 * explicitly. That threading is exactly what an `AsyncLocalStorage` removes.
 *
 * This module owns a SINGLE process-wide `AsyncLocalStorage<TraceRef>`. When a
 * tracer runs `withSpan(...)`, it wraps the body in `runWithActiveTraceRef(ref,
 * fn)` so every descendant async frame reads the same `ref` via
 * `getActiveTraceRef()` — and two concurrently-interleaved `withSpan` scopes get
 * INDEPENDENT stores (that is the whole point of AsyncLocalStorage over a global
 * mutable "current span" variable: no cross-talk under interleaving).
 *
 * `TraceRef` = the port's `SpanContext` (`traceId` / `spanId` / `traceFlags`)
 * plus an optional `parentSpanId`. We REUSE `SpanContext` rather than declaring
 * a parallel identity type — a `TraceRef` IS a span context, with the parent
 * edge attached so a caller reading the active ref can reconstruct the tree edge
 * without a second lookup.
 *
 * Plane-clean: imports only `node:async_hooks` and `./port`.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { SpanContext } from "./port"

/** The active-span reference published into async context. A `SpanContext`
 *  (the on-the-wire identity) plus the optional parent span id, so a nested
 *  caller reading `getActiveTraceRef()` knows both "who am I under" and "what
 *  is my own id". */
export interface TraceRef extends SpanContext {
  /** 16-hex lowercase parent span id. Absent for a root span. */
  readonly parentSpanId?: string
}

/** Process-wide active-span store. One instance — sharing it is what makes a
 *  child span opened in a descendant async frame see its enclosing parent. */
const activeStore = new AsyncLocalStorage<TraceRef>()

/** Count of currently-live `runWithActiveTraceRef` scopes across the whole
 *  process. Positive ⇒ SOMETHING is driving spans through the async-context
 *  regime (the agent loop's `withActiveSpanScope`), so a sink that finds NO
 *  active ref at open time is looking at a genuine ROOT (a new trace) — it must
 *  NOT fall back to a process-global LIFO stack (which would cross-link two
 *  concurrent session roots — the exact jul-12 audit hazard). Zero ⇒ nobody
 *  installs context (the direct `startSpan`/`endSpan` unit-test / host path),
 *  so a stack fallback is the only parentage signal available. */
let activeScopeDepth = 0

/** True while at least one `runWithActiveTraceRef` scope is live in the
 *  process. The exporter consults this to decide whether a missing active ref
 *  means "genuine root" (regime on) or "use the LIFO fallback" (regime off). */
export const isActiveContextRegime = (): boolean => activeScopeDepth > 0

/** Run `fn` with `ref` installed as the active trace ref for the entire async
 *  subtree of `fn`. Concurrent calls with different refs never see each other's
 *  ref (AsyncLocalStorage isolation), so interleaved `withSpan` roots stay
 *  disjoint. Maintains {@link isActiveContextRegime} across the scope's
 *  lifetime (sync-throw AND async-settle safe). */
export const runWithActiveTraceRef = <T>(ref: TraceRef, fn: () => T): T => {
  activeScopeDepth++
  let out: T
  try {
    out = activeStore.run(ref, fn)
  } catch (e) {
    activeScopeDepth--
    throw e
  }
  // Async body: decrement only after the returned promise settles so the regime
  // stays "on" for the WHOLE async subtree (a nested root opened deep inside an
  // awaited body still sees the regime as active). Sync body: decrement now.
  const maybeThenable = out as unknown
  if (
    maybeThenable !== null &&
    typeof maybeThenable === "object" &&
    typeof (maybeThenable as PromiseLike<unknown>).then === "function"
  ) {
    const settle = (): void => {
      activeScopeDepth--
    }
    ;(maybeThenable as Promise<unknown>).then(settle, settle)
    return out
  }
  activeScopeDepth--
  return out
}

/** The active span for the current async call chain, or `undefined` when no
 *  `withSpan(...)` scope encloses this frame (or the tracer is in `off` mode,
 *  which installs no context). This is the ref other clusters import to stamp
 *  the enclosing span onto a recorder event / cassette metadata. */
export const getActiveTraceRef = (): TraceRef | undefined => activeStore.getStore()
