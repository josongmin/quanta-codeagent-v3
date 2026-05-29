/**
 * OpenTelemetry `TracerProvider`-backed `Tracer` adapter (ADR-0186).
 *
 * Closed-port adapter: our typed `Span` / `SpanContext` ↔ OTel's. Caller
 * constructs the `TracerProvider` (with their chosen exporters, sampler,
 * resource attrs, shutdown lifecycle) and hands it in — or omits it to use
 * the OTel global API. We never auto-instantiate one (Default-OFF per
 * ADR-0186).
 *
 * Why import `@opentelemetry/api` directly rather than declare a structural
 * surface (the metrics OTel sink chose structural)?
 *
 *   The tracing port needs to wire PARENT CONTEXTS through OTel's
 *   `context.with(setSpan(context.active(), parentSpan), …)` ceremony so
 *   downstream OTel-aware code (auto-instrumented HTTP client, third-party
 *   SDK) sees the same parent. Re-implementing that ceremony structurally
 *   means re-implementing the OTel Context API (`Context`, `setSpan`,
 *   `getSpan`, `context.with`, `wrapSpanContext`) — a moving target across
 *   OTel versions. The package is small (~50KB), so we depend directly and
 *   keep the bridge thin.
 *
 *   The METRICS sink could stay structural because counters/histograms have
 *   no parent context — `counter.add(value, attrs)` is leaf-shaped. Tracing
 *   isn't.
 *
 * Span / SpanContext type wrapping — the subtle bit:
 *
 *   - OUR `Span` carries a snapshot `context: SpanContext` (immutable struct).
 *   - OTEL's `Span` has `.spanContext(): SpanContext` (function).
 *   - We adapt one-way: take the OTel span, build a fresh struct from
 *     `otelSpan.spanContext()`, and store BOTH the OTel span (for delegation)
 *     and the struct (for caller-side equality / propagation).
 *   - When the caller passes our Span as a `parent` (i.e. they grabbed the
 *     `Span` from `startSpan` and are using it as a parent for a child),
 *     we recover the OTel span via a private WeakMap keyed by our Span
 *     object. WeakMap means a Span that's gone out of scope doesn't pin its
 *     OTel counterpart in memory.
 *   - When the caller passes a raw `SpanContext` as `parent` (e.g. from
 *     `w3cPropagator.extract(headers)`), we use OTel's `wrapSpanContext` to
 *     turn it into a non-recording Span that `setSpan(context, ·)` accepts.
 *
 * No-throw policy: EVERY OTel API call is wrapped in try/catch and swallowed.
 * Observability sinks must never break the recorder. Misbehaving providers
 * (exporter down, network partition, serialization bug) collapse to a no-op
 * span that the caller can still `.end()` on. We import `noopTracer` for
 * exactly this collapse path.
 *
 * Plane-clean: imports only `./port`, `./noop-tracer`, and `@opentelemetry/api`.
 * No `@/agent`, `@/tool`, `@/llm`, etc.
 */

import type {
  Context as OtelContextType,
  Span as OtelSpan,
  SpanOptions as OtelSpanOptions,
  Tracer as OtelTracerApi,
  TracerProvider as OtelTracerProviderType,
} from "@opentelemetry/api"
import {
  SpanKind as OtelSpanKind,
  SpanStatusCode as OtelSpanStatusCode,
  context as otelContext,
  trace as otelTrace,
} from "@opentelemetry/api"
import { errMessage } from "@/shared"
import { noopTracer } from "./noop-tracer"
import type { Span, SpanAttributes, SpanContext, SpanKind, SpanStatusCode, Tracer } from "./port"
// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export interface OtelTracerOpts {
  /** Caller-owned `TracerProvider`. Quanta does NOT auto-instantiate one —
   *  caller controls the OTel SDK lifecycle (exporter, sampler, resource,
   *  shutdown). When OMITTED, we fall back to the OTel global API
   *  (`trace.getTracer`) which respects whatever provider the surface
   *  registered globally. */
  readonly tracerProvider?: OtelTracerProviderType
  /** Logical tracer name (groups spans in the OTel UI). Default `"quanta"`. */
  readonly tracerName?: string
  /** Optional version (passed to `getTracer(name, version)`). When absent,
   *  the OTel default of "no version" is used. */
  readonly tracerVersion?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Kind / status mapping (closed switches over our 5-arm + 3-arm unions)
// ────────────────────────────────────────────────────────────────────────────

/** Map our `SpanKind` to OTel's enum. The exhaustive switch with `never`
 *  fallthrough means a future addition to our union triggers a compile
 *  error here — exactly the slice-isolation invariant we want. */
export const mapKind = (kind: SpanKind | undefined): OtelSpanKind => {
  if (kind === undefined) return OtelSpanKind.INTERNAL
  switch (kind) {
    case "internal":
      return OtelSpanKind.INTERNAL
    case "server":
      return OtelSpanKind.SERVER
    case "client":
      return OtelSpanKind.CLIENT
    case "producer":
      return OtelSpanKind.PRODUCER
    case "consumer":
      return OtelSpanKind.CONSUMER
    default: {
      const _exhaustive: never = kind
      void _exhaustive
      return OtelSpanKind.INTERNAL
    }
  }
}

const mapStatus = (code: SpanStatusCode): OtelSpanStatusCode => {
  switch (code) {
    case "unset":
      return OtelSpanStatusCode.UNSET
    case "ok":
      return OtelSpanStatusCode.OK
    case "error":
      return OtelSpanStatusCode.ERROR
    default: {
      const _exhaustive: never = code
      void _exhaustive
      return OtelSpanStatusCode.UNSET
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: our Span ↔ OTel span bridge
// ────────────────────────────────────────────────────────────────────────────

/** Private WeakMap from our Span objects back to the OTel span we wrapped.
 *  WeakMap means once a caller drops the Span reference, GC reclaims both
 *  our wrapper AND the OTel span entry — no leak. */
const ourToOtelSpan = new WeakMap<Span, OtelSpan>()

/** Build our Span by wrapping an OTel span. Captures a snapshot of
 *  `spanContext()` so callers reading `.context` get a stable struct (OTel's
 *  `.spanContext()` is a function call — we don't want to re-invoke it on
 *  every read, and we want our SpanContext to be `readonly`). */
const wrapOtelSpan = (otelSpan: OtelSpan): Span => {
  // Snapshot the SpanContext. OTel returns its own type but we project to
  // our 3-field struct so the surface stays minimal. We deliberately do
  // NOT carry `traceState` or `isRemote` — both are OTel-internal concerns
  // for the propagation chain, and our `TraceContextPropagator` handles
  // `tracestate` separately when/if we ever wire it.
  let snapshot: SpanContext
  try {
    const ctx = otelSpan.spanContext()
    snapshot = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      traceFlags: ctx.traceFlags,
    }
  } catch {
    // Defensive — if OTel itself throws on spanContext(), fall back to a
    // zero-shaped context. The caller still gets a usable Span object.
    snapshot = { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }
  }

  let ended = false // local idempotence guard; `end()` second-call is a no-op

  const our: Span = {
    context: snapshot,
    setAttribute(key, value) {
      try {
        otelSpan.setAttribute(key, value)
      } catch {
        // no-throw — observability must not crash callers
      }
    },
    setStatus(code, message) {
      try {
        if (code === "error") {
          // SpanStatus.message is only meaningful for ERROR per W3C / OTel
          otelSpan.setStatus(
            message === undefined ? { code: mapStatus(code) } : { code: mapStatus(code), message },
          )
        } else {
          otelSpan.setStatus({ code: mapStatus(code) })
        }
      } catch {
        // no-throw
      }
    },
    recordException(error) {
      try {
        otelSpan.recordException(error)
      } catch {
        // no-throw
      }
    },
    end(endTime) {
      if (ended) return
      ended = true
      try {
        // OTel's `TimeInput` accepts number (epoch ms) directly.
        if (endTime === undefined) otelSpan.end()
        else otelSpan.end(endTime)
      } catch {
        // no-throw
      }
    },
  }
  ourToOtelSpan.set(our, otelSpan)
  return our
}

/** Build an OTel `Context` carrying `parent` as its active span. Used when
 *  the caller passes a parent — we lift that parent into the OTel context
 *  stack so downstream OTel code sees the right tree.
 *
 *  - parent is our Span      → look up the cached OTel span (WeakMap), or
 *                              if the cache miss happens (unlikely — e.g.
 *                              caller hand-built a Span), fall back to
 *                              wrapping `parent.context` as a non-recording
 *                              span.
 *  - parent is a SpanContext → wrap it via `trace.wrapSpanContext` to get a
 *                              non-recording Span, then `trace.setSpan`. This
 *                              is the W3C-extract path: the parent came from
 *                              another process. */
const contextWithParent = (parent: SpanContext | Span): OtelContextType | undefined => {
  try {
    const active = otelContext.active()
    // Heuristic: our Span has `context` property; raw SpanContext doesn't
    // have it, only `traceId/spanId/traceFlags`. The shape test is safe
    // because SpanContext fields are required string/number.
    if ("context" in parent) {
      const cached = ourToOtelSpan.get(parent)
      if (cached !== undefined) {
        return otelTrace.setSpan(active, cached)
      }
      // Cache miss — synthesize from the snapshot context.
      const wrapped = otelTrace.wrapSpanContext({
        traceId: parent.context.traceId,
        spanId: parent.context.spanId,
        traceFlags: parent.context.traceFlags,
      })
      return otelTrace.setSpan(active, wrapped)
    }
    const wrapped = otelTrace.wrapSpanContext({
      traceId: parent.traceId,
      spanId: parent.spanId,
      traceFlags: parent.traceFlags,
    })
    return otelTrace.setSpan(active, wrapped)
  } catch {
    return undefined
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public factory
// ────────────────────────────────────────────────────────────────────────────

/** Construct an OTel-backed `Tracer`. Caller owns the `TracerProvider`
 *  lifecycle (or omits it to use the OTel global API). */
export const otelTracer = (opts?: OtelTracerOpts): Tracer => {
  const tracerName = opts?.tracerName ?? "quanta"
  const tracerVersion = opts?.tracerVersion

  /** Lazy: only call `getTracer` on first use. Subsequent calls reuse. */
  let otelTracerApi: OtelTracerApi | undefined

  const getTracer = (): OtelTracerApi | undefined => {
    if (otelTracerApi !== undefined) return otelTracerApi
    try {
      const provider = opts?.tracerProvider
      if (provider !== undefined) {
        otelTracerApi =
          tracerVersion === undefined
            ? provider.getTracer(tracerName)
            : provider.getTracer(tracerName, tracerVersion)
      } else {
        // Fall back to the OTel global API. When no global provider is
        // registered, `trace.getTracer` returns a no-op tracer — exactly
        // what we want (the wrapping below still works, just produces
        // non-recording spans).
        otelTracerApi =
          tracerVersion === undefined
            ? otelTrace.getTracer(tracerName)
            : otelTrace.getTracer(tracerName, tracerVersion)
      }
      return otelTracerApi
    } catch {
      // Provider misconfigured — caller will see no-op spans (collapse
      // path below). Don't cache the failure: next call will retry, which
      // matters when the caller wires a provider after first use.
      return undefined
    }
  }

  /** Build OTel `SpanOptions` from our opts. exactOptionalPropertyTypes:
   *  every field is set ONLY when present in input (no `kind: undefined`
   *  leaks). */
  const buildSpanOpts = (opts2?: {
    readonly kind?: SpanKind
    readonly attributes?: SpanAttributes
    readonly startTime?: number
  }): OtelSpanOptions => {
    const out: OtelSpanOptions = {}
    out.kind = mapKind(opts2?.kind)
    if (opts2?.attributes !== undefined) {
      // Our SpanAttributes is structurally compatible with OTel's
      // Attributes for the primitive subset we allow (string/number/bool).
      out.attributes = opts2.attributes as Record<string, string | number | boolean>
    }
    if (opts2?.startTime !== undefined) {
      out.startTime = opts2.startTime
    }
    return out
  }

  const tracer: Tracer = {
    startSpan(name, opts2) {
      const api = getTracer()
      if (api === undefined) return noopTracer.startSpan(name, opts2)
      const spanOpts = buildSpanOpts(opts2)
      try {
        const parent = opts2?.parent
        if (parent === undefined) {
          return wrapOtelSpan(api.startSpan(name, spanOpts))
        }
        const ctx = contextWithParent(parent)
        if (ctx === undefined) {
          // Couldn't lift parent into OTel context — degrade to root span
          // rather than crash. The trace tree will lose this edge but the
          // caller's code path is unaffected.
          return wrapOtelSpan(api.startSpan(name, spanOpts))
        }
        return wrapOtelSpan(api.startSpan(name, spanOpts, ctx))
      } catch {
        // Tracer / startSpan threw — collapse to no-op.
        return noopTracer.startSpan(name, opts2)
      }
    },
    async withSpan(name, fn, opts2) {
      const span = this.startSpan(name, opts2)
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
    },
  }
  return tracer
}
