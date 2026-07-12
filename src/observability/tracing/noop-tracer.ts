/**
 * No-op `Tracer` adapter (ADR-0186).
 *
 * Returned by the barrel as `defaultTracer`. With nothing wired, callers
 * still call `startSpan` / `withSpan` and get back a `Span` they can pass to
 * subsystems, set attributes on, etc. — but no observation is emitted and no
 * exporter is touched. This is the byte-identical "no tracing" path: the
 * surface (apps/agent bootstrap, dispatch instrument) decides whether to
 * upgrade to `otelTracer(...)`.
 *
 * Span IDs are still well-formed (32-hex traceId, 16-hex spanId, flags=0
 * because un-sampled) so the no-op span is INDISTINGUISHABLE in shape from a
 * real span — callers that pass the context across a process boundary won't
 * crash a downstream parser, they just won't see the span on the collector.
 *
 * The randomness uses `crypto.getRandomValues` (Bun + Node 20+ have this
 * globally) so even the no-op path produces uncorrelated IDs across parallel
 * spans (the test suite asserts this — test 5 of section A).
 *
 * Plane-clean: imports ONLY `./port`. Zero external deps — no OTel package
 * cost when the user hasn't opted in.
 */

import { errMessage } from "@/shared"
import { getActiveTraceRef, runWithActiveTraceRef, type TraceRef } from "./active-context"
import type { Span, SpanAttributes, SpanContext, SpanKind, SpanStatusCode, Tracer } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Hex ID generation (W3C: 32-hex traceId / 16-hex spanId, both lowercase)
// ────────────────────────────────────────────────────────────────────────────

/** Fill `byteCount` bytes with crypto-strong randomness and hex-encode. Uses
 *  `crypto.getRandomValues` (WebCrypto, available globally on Bun + Node 20+).
 *  No fallback — if the global is missing, we'd rather crash here than emit
 *  predictable IDs (predictable trace IDs collide and silently merge unrelated
 *  traces on the collector). */
const randomHex = (byteCount: number): string => {
  const bytes = new Uint8Array(byteCount)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out += (b < 0x10 ? "0" : "") + b.toString(16)
  }
  return out
}

/** Build a fresh W3C-shaped no-op `SpanContext`. flags=0 (un-sampled) marks
 *  this as a non-recording span on any downstream collector — the IDs are
 *  syntactically valid but the consumer will drop them per the sampled-bit
 *  contract. */
const newNoopContext = (): SpanContext => ({
  traceId: randomHex(16), // 16 bytes → 32 hex
  spanId: randomHex(8), //  8 bytes → 16 hex
  traceFlags: 0,
})

// ────────────────────────────────────────────────────────────────────────────
// No-op Span (every method is a deliberate no-op except `context` access)
// ────────────────────────────────────────────────────────────────────────────

/** Builds a fresh no-op span. Each call gets independent IDs so callers can
 *  pass several spans across a boundary without collision. Inheriting from a
 *  `parent` (Span or SpanContext) preserves the trace ID — child spans share
 *  the parent's trace so a future OTel-backed deployment of the same code
 *  path produces the same tree shape. */
const newNoopSpan = (parent?: SpanContext | Span): Span => {
  const parentCtx: SpanContext | undefined =
    parent === undefined
      ? undefined
      : "context" in parent
        ? parent.context // it's a Span
        : parent // it's a raw SpanContext
  const context: SpanContext =
    parentCtx === undefined
      ? newNoopContext()
      : {
          // Inherit traceId from parent → child belongs to the same trace.
          traceId: parentCtx.traceId,
          spanId: randomHex(8),
          // Inherit sampled bit from parent so a parent that decides "yes,
          // sample me" carries through. (No-op path will always be 0
          // anyway, but this rule matters when the noop tracer is fed a
          // parent context that came from an upstream real tracer via
          // W3C extract.)
          traceFlags: parentCtx.traceFlags,
        }
  return {
    context,
    setAttribute(_key: string, _value: string | number | boolean): void {
      // no-op
    },
    setStatus(_code: SpanStatusCode, _message?: string): void {
      // no-op
    },
    recordException(_error: Error): void {
      // no-op
    },
    end(_endTime?: number): void {
      // no-op
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public no-op Tracer
// ────────────────────────────────────────────────────────────────────────────

const spanIdOf = (parent: SpanContext | Span | undefined): string | undefined => {
  if (parent === undefined) return undefined
  return "context" in parent ? parent.context.spanId : parent.spanId
}

/** Shared span-scope body used by both the CONTEXT-mode and OFF-mode tracers.
 *  `installContext` decides whether the started span becomes the active ref for
 *  the async subtree (context mode) or not (off mode). Both mint valid IDs and
 *  never touch an exporter. */
const runNoopWithSpan = async <T>(
  installContext: boolean,
  fn: (span: Span) => Promise<T>,
  span: Span,
  parentSpanId: string | undefined,
): Promise<T> => {
  const body = async (): Promise<T> => {
    try {
      const out = await fn(span)
      span.setStatus("ok")
      return out
    } catch (e) {
      if (e instanceof Error) {
        span.recordException(e)
        span.setStatus("error", e.message)
      } else {
        span.setStatus("error", errMessage(e))
      }
      throw e
    } finally {
      span.end()
    }
  }
  if (!installContext) return body()
  const ref: TraceRef = {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    traceFlags: span.context.traceFlags,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
  }
  return runWithActiveTraceRef(ref, body)
}

/** CONTEXT-mode / OFF-mode tracer factory. `context` mode installs the started
 *  span into `AsyncLocalStorage` so nested async callers see it as their parent
 *  (valid IDs, NO export). `off` mode is byte-identical to "no tracing wired":
 *  it mints IDs but installs NOTHING, so `getActiveTraceRef()` stays undefined
 *  and no async-context frame is pushed. */
const makeNoExportTracer = (installContext: boolean): Tracer => ({
  startSpan(
    _name: string,
    opts?: {
      readonly kind?: SpanKind
      readonly parent?: SpanContext | Span
      readonly attributes?: SpanAttributes
      readonly startTime?: number
    },
  ): Span {
    // Implicit parent from the active ref (context mode only — off mode never
    // installs a ref, so this is always undefined there).
    const active = installContext ? getActiveTraceRef() : undefined
    return newNoopSpan(opts?.parent ?? active)
  },
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    opts?: {
      readonly kind?: SpanKind
      readonly parent?: SpanContext | Span
      readonly attributes?: SpanAttributes
      readonly startTime?: number
    },
  ): Promise<T> {
    const parentSpanId =
      spanIdOf(opts?.parent) ?? (installContext ? getActiveTraceRef()?.spanId : undefined)
    const span = this.startSpan(name, opts)
    return runNoopWithSpan(installContext, fn, span, parentSpanId)
  },
})

/** CONTEXT mode: mints valid W3C IDs AND publishes the active span into
 *  async-local context — WITHOUT export. Use when you want in-process
 *  parent/child causality (nested spans, `getActiveTraceRef`) but no OTLP
 *  egress. */
export const contextTracer: Tracer = makeNoExportTracer(true)

/** Default tracer used when nothing is wired (OFF mode). Drop-in replaceable
 *  with `otelTracer(...)` or `contextTracer`; same interface, same call sites.
 *  Installs NO async context — byte-identical to "no tracing". */
export const noopTracer: Tracer = makeNoExportTracer(false)
