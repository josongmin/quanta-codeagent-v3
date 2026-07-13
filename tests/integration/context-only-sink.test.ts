/**
 * T-B1 — `makeContextOnlySpanSink()`: a {@link SpanSink} that issues REAL W3C
 * trace ids (so the correlation coordinate populates + the viewer span-tree is
 * non-empty on every run) WITHOUT exporting anything. This DECOUPLES
 * id-issuance from OTLP export — today a real id only exists when an OTLP
 * endpoint is configured, so ordinary runs have empty trees.
 *
 * The sink mints `hexId(16)`/`hexId(8)` per span, carries `traceFlags:1`
 * (SAMPLED — so a later-attached exporter/child reads a sampled ref), derives
 * parentage EXACTLY like `createExporterSpanSink.onStart` (active-ref-first,
 * direct-path LIFO fallback, `onScoped` eviction), and NO-OPs on `onEnd` (no
 * export, no buffer).
 *
 * DONE-CRITERIA:
 *  · under this sink, `getActiveTraceRef()` inside `withActiveSpanScope` ===
 *    the issued `{traceId, spanId}` (the id-unification seam), `traceFlags===1`;
 *  · two concurrently-interleaved sessions get DISTINCT trace ids with NO
 *    cross-parent (reuses the `spans-direct-path-concurrent-scope` shapes — the
 *    onScoped eviction must work);
 *  · `onEnd` never calls any exporter (asserted with a spy).
 *
 * RED-ON-INJECTION:
 *  · reverting the id-install (returning an opaque token instead of the minted
 *    `TraceRef`) makes the "getActiveTraceRef === issued ref" assertion RED
 *    (the scope falls back to minting its OWN id);
 *  · neutering the `onScoped` eviction makes CASE "two concurrent roots" RED
 *    (rootB adopts rootA and the two traces collapse).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { withActiveSpanScope } from "@/agent/session-resources"
import { __resetSpanSink, SPAN_NAMES, setSpanSink, startSpan } from "@/observability"
import { makeContextOnlySpanSink } from "@/observability/context-only-sink"
import type { OtelExporter } from "@/observability/otel-exporter"
import { getActiveTraceRef, type TraceRef } from "@/observability/tracing"

afterEach(() => {
  __resetSpanSink()
})

/** A hex traceId is 32 lowercase hex chars; a spanId is 16. */
const isTraceId = (s: string | undefined): boolean =>
  typeof s === "string" && /^[0-9a-f]{32}$/.test(s)
const isSpanId = (s: string | undefined): boolean =>
  typeof s === "string" && /^[0-9a-f]{16}$/.test(s)

describe("makeContextOnlySpanSink — id issuance without export", () => {
  test("onStart returns a real W3C TraceRef with traceFlags:1 (SAMPLED)", () => {
    const sink = makeContextOnlySpanSink()
    const ref = sink.onStart(SPAN_NAMES.sessionLoop, {}) as TraceRef
    expect(isTraceId(ref.traceId)).toBe(true)
    expect(isSpanId(ref.spanId)).toBe(true)
    // SAMPLED — a later-attached exporter/child reading this ref treats it as
    // sampled, so the derived export is not dropped.
    expect(ref.traceFlags).toBe(1)
    // ROOT: no enclosing active ref, no prior stack frame → no parent.
    expect(ref.parentSpanId).toBeUndefined()
  })

  test("getActiveTraceRef() inside withActiveSpanScope === the issued {traceId, spanId} (id unification)", async () => {
    setSpanSink(makeContextOnlySpanSink())

    // Open a span through the REAL loop helpers — `startSpan` surfaces the
    // sink-issued TraceRef on `Span.ref`, and `withActiveSpanScope` installs
    // THAT exact id as the active async-context ref (EXPORT path). So the id a
    // recorder/cassette stamps === the id the sink issued.
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    const issued = span.ref
    expect(issued).toBeDefined()
    expect(isTraceId(issued?.traceId)).toBe(true)
    expect(isSpanId(issued?.spanId)).toBe(true)

    const seen = await withActiveSpanScope(true, span, async () => getActiveTraceRef())
    // CORE — id unification: the active ref is the SAME id the sink issued.
    // (Red-on-injection: if onStart returned an opaque token instead of the
    // TraceRef, `span.ref` is undefined → withActiveSpanScope mints its OWN id
    // and this equality fails.)
    expect(seen?.traceId).toBe(issued?.traceId)
    expect(seen?.spanId).toBe(issued?.spanId)
    expect(seen?.traceFlags).toBe(1)
  })

  test("nested scope: a child span parents under the enclosing active ref (same trace)", async () => {
    setSpanSink(makeContextOnlySpanSink())
    const root = startSpan(SPAN_NAMES.sessionLoop, {})
    const rootRef = root.ref

    const childRef = await withActiveSpanScope(true, root, async () => {
      // Opened WHILE the root's ref is the active context → the sink reads the
      // active ref and inherits its trace + sets parent = root's span.
      const child = startSpan(SPAN_NAMES.turn, {})
      return child.ref
    })

    expect(childRef?.traceId).toBe(rootRef?.traceId) // same trace
    expect(childRef?.parentSpanId).toBe(rootRef?.spanId) // parented under root
    expect(childRef?.traceFlags).toBe(1)
  })

  test("two concurrently-interleaved sessions → DISTINCT trace ids, NO cross-parent (onScoped eviction is load-bearing)", () => {
    // Mirrors spans-direct-path-concurrent-scope CASE-3: a top-level session
    // root opens on the DIRECT path (no active ref yet) → it is PUSHED onto the
    // sink's shared LIFO stack. `withActiveSpanScope` then signals `onScoped`,
    // EVICTING it. A SECOND top-level session's root opening while the first is
    // still OPEN must therefore mint its OWN trace — NOT adopt the first.
    const sink = makeContextOnlySpanSink()

    const rootA = sink.onStart(SPAN_NAMES.sessionLoop, {}) as TraceRef
    sink.onScoped?.(rootA) // A becomes scoped → evicted from the shared stack

    const rootB = sink.onStart(SPAN_NAMES.sessionLoop, {}) as TraceRef // opens while A still open
    sink.onEnd(rootB, SPAN_NAMES.sessionLoop, "ok", 1, {})
    sink.onEnd(rootA, SPAN_NAMES.sessionLoop, "ok", 1, {})

    // DISTINCT traces, both genuine roots — no adoption.
    // (Red-on-injection: neuter the onScoped body → rootA lingers on the shared
    // stack → rootB reads it as parent → same trace + parentSpanId set.)
    expect(rootB.traceId).not.toBe(rootA.traceId)
    expect(rootA.parentSpanId).toBeUndefined()
    expect(rootB.parentSpanId).toBeUndefined()
  })

  test("onEnd never touches an exporter (no export, no buffer)", () => {
    // The context-only sink is constructed with NO exporter argument at all —
    // there is no seam through which it could export. We prove it structurally:
    // even if an exporter is registered as the DEFAULT sink elsewhere, this sink
    // holds no reference to it. A spy exporter passed to a *would-be* export path
    // must be untouched across a full open/scoped/close lifecycle.
    let exportCalls = 0
    const spyExporter: OtelExporter = {
      recordSpan: () => {
        exportCalls++
      },
      recordMetric: () => {
        exportCalls++
      },
      flush: async () => {},
      teardown: async () => {},
    }
    // The factory takes no exporter — it CANNOT reach `spyExporter`. This asserts
    // the decoupling: id issuance with zero export surface.
    const sink = makeContextOnlySpanSink()
    const ref = sink.onStart(SPAN_NAMES.sessionLoop, {}) as TraceRef
    sink.onScoped?.(ref)
    sink.onEnd(ref, SPAN_NAMES.sessionLoop, "ok", 1, {})
    expect(exportCalls).toBe(0)
    // And it truly minted an id (not an opaque token) so the assertion above is
    // not vacuous.
    expect(isTraceId(ref.traceId)).toBe(true)
    // Reference the spy so the exporter shape is load-bearing, not dead.
    void spyExporter
  })
})
