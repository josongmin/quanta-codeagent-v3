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

/** Run `fn` with `ref` installed as the active trace ref for the entire async
 *  subtree of `fn`. Concurrent calls with different refs never see each other's
 *  ref (AsyncLocalStorage isolation), so interleaved `withSpan` roots stay
 *  disjoint. */
export const runWithActiveTraceRef = <T>(ref: TraceRef, fn: () => T): T =>
  activeStore.run(ref, fn)

/** The active span for the current async call chain, or `undefined` when no
 *  `withSpan(...)` scope encloses this frame (or the tracer is in `off` mode,
 *  which installs no context). This is the ref other clusters import to stamp
 *  the enclosing span onto a recorder event / cassette metadata. */
export const getActiveTraceRef = (): TraceRef | undefined => activeStore.getStore()
