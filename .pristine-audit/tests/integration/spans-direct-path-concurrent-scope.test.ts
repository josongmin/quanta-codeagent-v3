/**
 * REGRESSION (jul-13 HIGH tracing defect) — DIRECT-path parentage must NOT be
 * suppressed by an UNRELATED concurrent async-context scope.
 *
 * The defect: `otel-span-export.ts onStart` used to gate its shared LIFO-stack
 * parent fallback on a PROCESS-GLOBAL scope-depth counter
 * (`isActiveContextRegime()`), while the active-ref it read
 * (`getActiveTraceRef()`) is per-async-context. So a span opened on the DIRECT
 * path (`startSpan`/`endSpan` WITHOUT `withActiveSpanScope`) had its stack
 * fallback WRONGLY suppressed whenever an *unrelated* concurrent session held a
 * `runWithActiveTraceRef` scope open — the direct-path child was orphaned
 * (fresh traceId, no parentSpanId) instead of nesting under its real stack
 * parent.
 *
 * The fix: the fallback is gated ONLY on the per-context async-local
 * (`getActiveTraceRef() === undefined`), and scoped spans are kept OUT of the
 * shared stack entirely — so concurrent scoped sessions cannot cross-link
 * through it and the global counter is gone.
 *
 * RED-ON-INJECTION: reverting to the global-counter gate (re-adding
 * `activeScopeDepth`/`isActiveContextRegime` and `&& !isActiveContextRegime()`)
 * makes CASE-1 fail — the host child orphans while the concurrent scope is live.
 *
 * CASE-3 pins the `onScoped` EVICTION primitive directly (neutering the eviction
 * body makes it RED). CASE-4 pins the WRAPPER-FORWARDING CONTRACT: a decorator
 * that wraps a stack-keeping sink but DROPS `onScoped` silently reintroduces the
 * concurrent-session trace-collapse — the drift-guard that a future composite
 * sink cannot forget the forward without a test going red.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { __resetSpanSink, SPAN_NAMES, type SpanSink } from "@/observability"
import type { ExportSpan, OtelExporter } from "@/observability/otel-exporter"
import { createExporterSpanSink } from "@/observability/otel-span-export"
import { runWithActiveTraceRef, type TraceRef } from "@/observability/tracing"

/** A capturing exporter — every closed span lands in `spans` verbatim. */
const capturingExporter = (): { exporter: OtelExporter; spans: ExportSpan[] } => {
  const spans: ExportSpan[] = []
  const exporter: OtelExporter = {
    recordSpan: (s) => spans.push(s),
    recordMetric: () => {},
    flush: async () => {},
    teardown: async () => {},
  }
  return { exporter, spans }
}

/** Deterministic distinct-bytes CSPRNG seam (traceId=0x00…, span=0x01…, …). */
const makeSeq = (): ((n: number) => Uint8Array) => {
  let seed = 0
  return (n: number) => {
    const a = new Uint8Array(n)
    a.fill(seed & 0xff)
    seed++
    return a
  }
}

/** A hand-built active ref, standing in for another session's live scope. */
const foreignRef = (): TraceRef => ({
  traceId: "ffffffffffffffffffffffffffffffff",
  spanId: "eeeeeeeeeeeeeeee",
  traceFlags: 1,
})

/** Await a promise that resolves on the next macrotask — lets a
 *  `runWithActiveTraceRef` async body stay MID-FLIGHT (its scope live) while we
 *  drive the direct path on the OUTER async context. */
const untilRelease = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}

afterEach(() => {
  __resetSpanSink()
})

describe("direct-path parentage under a concurrent active-context scope", () => {
  test("CASE-1: a DIRECT-path host child parents under its host root even while an UNRELATED scope is mid-flight", async () => {
    const { exporter, spans } = capturingExporter()
    // NB: NO fixedTraceId — a suppressed fallback would MINT a fresh trace for
    // the child, which the assertions below catch as an orphan.
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq(), now: () => 1000 })

    const gate = untilRelease()
    // A concurrent, UNRELATED session installs an active-context scope and stays
    // mid-flight (its async body awaits `gate`). Under the OLD code this drove
    // the process-global scope-depth counter to 1 (regime ON).
    const scope = runWithActiveTraceRef(foreignRef(), async () => {
      await gate.promise
    })

    // On the OUTER async context (NO active ref of its own) drive the DIRECT
    // path: a host root then a host child — exactly `startSpan`/`endSpan`
    // WITHOUT `withActiveSpanScope`. The child must adopt the root via the
    // shared LIFO stack.
    const root = sink.onStart(SPAN_NAMES.sessionLoop, {})
    const child = sink.onStart(SPAN_NAMES.turn, {})
    sink.onEnd(child, SPAN_NAMES.turn, "ok", 1, {})
    sink.onEnd(root, SPAN_NAMES.sessionLoop, "ok", 1, {})

    // Release the concurrent scope and let it settle.
    gate.release()
    await scope

    const rootExp = spans.find((s) => s.name === SPAN_NAMES.sessionLoop)
    const childExp = spans.find((s) => s.name === SPAN_NAMES.turn)
    expect(rootExp).toBeDefined()
    expect(childExp).toBeDefined()
    // CORE: the child is NOT orphaned — it nests under the host root, same
    // trace, parent = root's spanId. The OLD global-counter gate suppressed the
    // stack fallback here and the child would mint its OWN trace with no parent.
    expect(childExp?.parentSpanId).toBe(rootExp?.spanId)
    expect(childExp?.traceId).toBe(rootExp?.traceId)
    // And it never adopted the foreign (concurrent session's) ref.
    expect(childExp?.traceId).not.toBe(foreignRef().traceId)
    expect(childExp?.parentSpanId).not.toBe(foreignRef().spanId)
    // Root itself is a genuine root (no parent).
    expect(rootExp?.parentSpanId).toBeUndefined()
  })

  test("CASE-2: a SCOPED span never leaks onto the shared stack — a later direct-path root mints its OWN trace", async () => {
    const { exporter, spans } = capturingExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq() })

    // Open + close a SCOPED span (a live active ref encloses it). If scoped
    // frames were pushed onto the shared LIFO stack, they could linger there
    // (out-of-LIFO close, or a straggler) and a subsequent direct-path root
    // would WRONGLY adopt the scoped span as parent.
    const foreign = foreignRef()
    runWithActiveTraceRef(foreign, () => {
      const scoped = sink.onStart(SPAN_NAMES.turn, {})
      sink.onEnd(scoped, SPAN_NAMES.turn, "ok", 1, {})
    })

    // Now, OUTSIDE any scope (no active ref), open a fresh direct-path root.
    const root = sink.onStart(SPAN_NAMES.sessionLoop, {})
    sink.onEnd(root, SPAN_NAMES.sessionLoop, "ok", 1, {})

    const scopedExp = spans.find((s) => s.name === SPAN_NAMES.turn)
    const rootExp = spans.find((s) => s.name === SPAN_NAMES.sessionLoop)
    expect(scopedExp).toBeDefined()
    expect(rootExp).toBeDefined()
    // The scoped span parented under its OWN active ref (the foreign scope),
    // proving it used the async-local, not the shared stack.
    expect(scopedExp?.parentSpanId).toBe(foreign.spanId)
    expect(scopedExp?.traceId).toBe(foreign.traceId)
    // The later direct-path root is a GENUINE root: no parent, its OWN fresh
    // trace — it did NOT adopt the leaked scoped frame.
    expect(rootExp?.parentSpanId).toBeUndefined()
    expect(rootExp?.traceId).not.toBe(scopedExp?.traceId)
    expect(rootExp?.traceId).not.toBe(foreign.traceId)
  })

  test("CASE-3: onScoped EVICTS a direct-path frame — a subsequent direct-path root does NOT adopt the evicted (now-scoped) span", () => {
    const { exporter, spans } = capturingExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq() })

    // A top-level session root opens on the DIRECT path (no active ref yet) →
    // it is PUSHED onto the shared stack. It stays OPEN (session still running).
    const rootA = sink.onStart(SPAN_NAMES.sessionLoop, {})
    // `withActiveSpanScope` would now install rootA as the active ref and signal
    // `markSpanScoped` → the sink evicts it from the shared stack.
    sink.onScoped?.(rootA)

    // While rootA is still OPEN, a SECOND top-level session opens its own root on
    // the direct path. With eviction done, the stack is empty → rootB is a
    // genuine root minting its OWN trace. WITHOUT eviction, rootB would read
    // rootA off the stack and adopt it — collapsing two sessions into one trace.
    const rootB = sink.onStart(SPAN_NAMES.sessionLoop, {})
    sink.onEnd(rootB, SPAN_NAMES.sessionLoop, "ok", 1, {})
    sink.onEnd(rootA, SPAN_NAMES.sessionLoop, "ok", 1, {})

    const a = spans.find((s) => s.spanId === (rootA as TraceRef).spanId)
    const b = spans.find((s) => s.spanId === (rootB as TraceRef).spanId)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    // Both are genuine roots with DISTINCT traces — no adoption.
    expect(a?.parentSpanId).toBeUndefined()
    expect(b?.parentSpanId).toBeUndefined()
    expect(b?.traceId).not.toBe(a?.traceId)
  })

  test("CASE-4: WRAPPER-FORWARDING CONTRACT — a decorator that drops onScoped collapses two sessions; forwarding keeps them distinct", () => {
    // Encodes the invariant documented on `SpanSink.onScoped`: any wrapper of a
    // stack-keeping sink MUST forward onScoped. We drive the exact two-session
    // collapse shape at the sink level through two wrappers.
    const drive = (wrap: (inner: SpanSink) => SpanSink): { aTrace: string; bTrace: string } => {
      const { exporter, spans } = capturingExporter()
      const sink = wrap(createExporterSpanSink(exporter, { randomBytes: makeSeq() }))
      const rootA = sink.onStart(SPAN_NAMES.sessionLoop, {})
      sink.onScoped?.(rootA) // A becomes scoped
      const rootB = sink.onStart(SPAN_NAMES.sessionLoop, {}) // B opens while A live
      sink.onEnd(rootB, SPAN_NAMES.sessionLoop, "ok", 1, {})
      sink.onEnd(rootA, SPAN_NAMES.sessionLoop, "ok", 1, {})
      const a = spans.find((s) => s.spanId === (rootA as TraceRef).spanId)
      const b = spans.find((s) => s.spanId === (rootB as TraceRef).spanId)
      return { aTrace: a?.traceId ?? "", bTrace: b?.traceId ?? "" }
    }

    // GOOD wrapper — forwards ALL three methods (the required contract).
    const good = drive((inner) => ({
      onStart: (n, at) => inner.onStart(n, at),
      onEnd: (t, n, s, d, at) => inner.onEnd(t, n, s, d, at),
      onScoped: (t) => inner.onScoped?.(t),
    }))
    // The two roots keep DISTINCT traces — eviction reached the inner sink.
    expect(good.bTrace).not.toBe(good.aTrace)
    expect(good.aTrace).not.toBe("")
    expect(good.bTrace).not.toBe("")

    // BAD wrapper — implements onStart/onEnd, FORGETS onScoped (still a valid
    // SpanSink because onScoped is optional). The eviction never reaches the
    // inner stack → rootB adopts rootA → both COLLAPSE into one trace. This is
    // the exact regression the contract forbids; the assertion documents it.
    const bad = drive((inner) => ({
      onStart: (n, at) => inner.onStart(n, at),
      onEnd: (t, n, s, d, at) => inner.onEnd(t, n, s, d, at),
      // onScoped intentionally omitted
    }))
    expect(bad.bTrace).toBe(bad.aTrace) // COLLAPSE — proves onScoped is load-bearing
  })
})
