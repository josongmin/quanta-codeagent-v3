/**
 * CONTEXT-ONLY SpanSink (T-B1) — issue REAL W3C trace ids WITHOUT exporting.
 *
 * Root cause the trajectory viewer's span-tree is empty on ordinary runs: a real
 * `{traceId, spanId}` only ever existed with an OTLP endpoint configured
 * (`installOtelSpanExportFromEnv` installs the exporter sink; otherwise the null
 * sink discards everything and no id is minted). This sink DECOUPLES id-issuance
 * from OTLP export: its `onStart` mints a W3C id (`hexId(16)`/`hexId(8)`) and
 * surfaces it as the span's {@link TraceRef} — exactly like the exporter sink —
 * so `withActiveSpanScope` installs that SAME id as the active async-context ref
 * and the recorder/cassette stamp the unified coordinate. But it exports
 * NOTHING: `onEnd` is a no-op (no buffer, no exporter reference at all).
 *
 * A later-attached exporter/child reads a SAMPLED ref (`traceFlags: 1`), so the
 * derived export (when an endpoint IS present) is not dropped.
 *
 * Parentage + concurrency are LOAD-BEARING and MUST match the exporter sink
 * byte-for-byte — two concurrently-interleaved sessions must get DISTINCT traces
 * with no cross-parent. Rather than re-implement (and risk drift), this reuses
 * the SHARED `resolveSpanParentage` / `evictScopedFrame` primitives from
 * `otel-span-export.ts` (the same ones `createExporterSpanSink` uses):
 * active-ref-first, direct-path LIFO fallback gated on `activeParent===undefined`,
 * push to the shared stack ONLY on the direct path, and `onScoped` EVICTION of a
 * now-scoped frame. The eviction is what keeps two top-level `runAgent` roots
 * from collapsing into one trace (pinned by
 * `spans-direct-path-concurrent-scope.test.ts` CASE-3/4 for the exporter, and by
 * `context-only-sink.test.ts` here).
 */

import { evictScopedFrame, resolveSpanParentage } from "./otel-span-export"
import type { SpanName, SpanSink } from "./spans"
import type { TraceRef } from "./tracing/active-context"

/** A {@link SpanSink} that MINTS a real W3C {@link TraceRef} per span (so the
 *  correlation coordinate populates + the viewer span-tree is non-empty on every
 *  run) but exports NOTHING. `onEnd` is a pure no-op — there is no exporter, no
 *  buffer. Parentage/eviction reuse the exporter sink's shared primitives, so a
 *  later-attached exporter or child reads a SAMPLED (`traceFlags:1`) ref and the
 *  concurrent-session trace-isolation contract is identical. NEVER throws. */
export const makeContextOnlySpanSink = (): SpanSink => {
  const gen = (len: number): Uint8Array => crypto.getRandomValues(new Uint8Array(len))
  // The shared direct-path LIFO fallback stack — parents a direct
  // `startSpan`/`endSpan` child under its host root when no active async-context
  // ref encloses the open. ONLY direct-path frames enter it; `onScoped` evicts a
  // frame once it becomes scoped (its parentage then lives in the async context).
  const open: TraceRef[] = []

  return {
    onStart(_name: SpanName, _attrs, _kind): unknown {
      // No `fixedTraceId` seam: production mints a fresh trace PER ROOT (a single
      // per-sink traceId would collapse every session/turn into one unbounded
      // trace — the same audit-Q1 hazard the exporter sink guards).
      const { ref, pushToStack } = resolveSpanParentage(open, gen)
      if (pushToStack) open.push(ref)
      // Return the TraceRef verbatim — `startSpan` surfaces it on `Span.ref`, and
      // `withActiveSpanScope` installs it as the active ref (EXPORT path). THIS is
      // the id-install that makes `getActiveTraceRef() === the issued id`.
      return ref
    },
    onScoped(token: unknown): void {
      // Evict the now-scoped frame from the shared stack so a CONCURRENT session's
      // root cannot adopt it (trace collapse). Mirrors the exporter's `onScoped`.
      evictScopedFrame(open, token as TraceRef)
    },
    onEnd(): void {
      // NO-OP — id-issuance is decoupled from export. Nothing is buffered or
      // shipped; the id already did its job (installed as the active ref at open).
    },
  }
}
