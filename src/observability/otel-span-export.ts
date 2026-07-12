/**
 * SPAN-EXPORT WIRING — the missing last mile between the agent loop's spans and
 * the OTLP exporter.
 *
 * The loop emits spans via `spans.ts` (`startSpan`/`endSpan` → the registered
 * {@link SpanSink}); the OTLP exporter (`otel-exporter.ts`) can ship spans to a
 * collector. But nothing connected them: `setSpanSink` had ZERO production
 * callers, so `QUANTA_OTEL_ENDPOINT` was a declared-but-dead knob — spans went
 * to the null sink and were discarded. This module is the bridge + the
 * env-driven install a HOST composition root calls once at startup.
 *
 *   host startup → installOtelSpanExportFromEnv(env)
 *                    → attachOtelExporterFromEnv(env)         (undefined ⇒ no-op)
 *                    → setSpanSink(createExporterSpanSink(exporter))
 *   ... agent loop startSpan/endSpan → exporter.recordSpan → OTLP/HTTP POST ...
 *   host shutdown → installed.teardown()                     (flush + restore sink)
 *
 * Default-OFF byte-identical: with `QUANTA_OTEL_ENDPOINT` unset, install is a
 * no-op (no sink registered, no exporter built) — exactly today's behavior.
 */

import { getDefaultMetricSink, setDefaultMetricSink } from "./metrics/in-memory-registry"
import {
  attachOtelExporterFromEnv,
  type ExportSpan,
  exporterMetricSink,
  type OtelExporter,
  type OtelExporterOpts,
} from "./otel-exporter"
import { getSpanSink, type SpanName, type SpanSink, type SpanStatus, setSpanSink } from "./spans"
import { getActiveTraceRef, isActiveContextRegime, type TraceRef } from "./tracing/active-context"
import type { SpanAttributes, SpanStatusCode } from "./tracing/port"

/** Loop span status → OTLP status code. `aborted` is a non-OK terminal state,
 *  so it maps to `error` (the OTLP code set is unset/ok/error only). */
const STATUS_MAP: Readonly<Record<SpanStatus, SpanStatusCode>> = {
  ok: "ok",
  error: "error",
  aborted: "error",
}

/** Random N bytes → lowercase hex. Default uses the platform CSPRNG; the
 *  hellgate injects a deterministic generator. */
const toHex = (n: number, gen: (len: number) => Uint8Array): string =>
  Array.from(gen(n), (b) => b.toString(16).padStart(2, "0")).join("")

export interface ExporterSpanSinkOpts {
  /** Epoch-ms clock. Default `Date.now`. Test seam. */
  readonly now?: () => number
  /** CSPRNG seam — returns `len` random bytes. Default `crypto.getRandomValues`. */
  readonly randomBytes?: (len: number) => Uint8Array
  /** Fixed 32-hex trace id (test seam). Default: one random trace per sink. */
  readonly traceId?: string
}

/** A {@link SpanSink} that forwards every closed span to an {@link OtelExporter}
 *  as an {@link ExportSpan}. Parent linkage is derived from a LIFO open-span
 *  stack (the loop nests sessionLoop > turn > stream), so the exported trace is
 *  a tree, not a flat list. NEVER throws (the sink contract): all the IO is
 *  inside `exporter.recordSpan`, which buffers and no-throws. */
export const createExporterSpanSink = (
  exporter: OtelExporter,
  opts: ExporterSpanSinkOpts = {},
): SpanSink => {
  const now = opts.now ?? Date.now
  const gen = opts.randomBytes ?? ((len: number) => crypto.getRandomValues(new Uint8Array(len)))
  // A FIXED traceId override (test seam) pins every root to one trace; otherwise
  // a fresh trace is minted PER ROOT span (audit Q1 — a single per-sink traceId
  // collapsed every session/turn of the whole process into one unbounded trace).
  const fixedTraceId = opts.traceId
  /** A Frame IS the {@link TraceRef} the exporter ISSUES for this span (the
   *  jul-12 OTel-GenAI unification): `spans.ts` surfaces it verbatim on
   *  `Span.ref`, and `withActiveSpanScope` installs it as the active
   *  async-context ref — so `getActiveTraceRef()` returns the EXACT id this
   *  exporter will POST to OTLP. `traceFlags` (sampled) is carried so the
   *  frame satisfies the `TraceRef`/`SpanContext` shape structurally. */
  interface Frame extends TraceRef {
    readonly startEpochMs: number
    /** Attributes supplied at span OPEN (`startSpan(name, attrs)`). The bridge
     *  used to DROP these — only `onEnd` attrs reached the exporter — so
     *  open-time facts like `quanta.tool.name` / `quanta.tool.input` silently
     *  never appeared in a trace. We now carry them and merge with the close
     *  attrs at `onEnd` (close wins on key collision). */
    readonly startAttrs: SpanAttributes
  }
  // Open-span stack for parent linkage — the FALLBACK when no active
  // async-context ref encloses the open (the direct-sink path: unit tests +
  // hosts that call startSpan/endSpan without wrapping the body in
  // `withActiveSpanScope`). A token IS its frame, so onEnd removes the EXACT
  // frame (`splice(idx, 1)`) — never the stragglers above it (audit Q2: a
  // one-arg `splice(idx)` dropped concurrent siblings, corrupting the tree
  // whenever tools/subagents close out of LIFO order).
  const open: Frame[] = []

  return {
    onStart(_name: SpanName, attrs): unknown {
      // Parentage authority (jul-12): when the loop installed the enclosing
      // span as the active async-context ref, THAT is the async-safe parent —
      // two concurrently-interleaved sessions read their OWN active ref, so
      // roots never cross-link. The LIFO stack is consulted ONLY on the direct
      // `startSpan`/`endSpan` path (no `withActiveSpanScope` regime live): in
      // the active-context regime a MISSING active ref means a genuine ROOT (a
      // new trace), NOT "adopt whatever concurrent-session frame sits on the
      // shared stack" — that stale-stack adoption is the exact cross-link the
      // async-context replacement exists to kill.
      const activeParent = getActiveTraceRef()
      const stackFallback =
        activeParent === undefined && !isActiveContextRegime() && open.length > 0
          ? open[open.length - 1]
          : undefined
      const parent: TraceRef | Frame | undefined = activeParent ?? stackFallback
      // Root (no parent) ⇒ a NEW trace; child ⇒ inherit the parent's trace.
      const traceId = parent?.traceId ?? fixedTraceId ?? toHex(16, gen)
      const frame: Frame = {
        spanId: toHex(8, gen),
        traceId,
        traceFlags: parent?.traceFlags ?? 1,
        ...(parent !== undefined ? { parentSpanId: parent.spanId } : {}),
        startEpochMs: now(),
        startAttrs: attrs as SpanAttributes,
      }
      open.push(frame)
      return frame
    },
    onEnd(token: unknown, name: SpanName, status: SpanStatus, durationMs: number, attrs): void {
      const frame = token as Frame
      const idx = open.lastIndexOf(frame)
      if (idx >= 0) open.splice(idx, 1) // remove ONLY this frame — never siblings
      // Merge OPEN + CLOSE attrs (close wins on collision) so open-time facts
      // (tool name/input) survive alongside close-time facts (status/output).
      const merged = { ...frame.startAttrs, ...(attrs as SpanAttributes) }
      const span: ExportSpan = {
        traceId: frame.traceId,
        spanId: frame.spanId,
        ...(frame.parentSpanId !== undefined ? { parentSpanId: frame.parentSpanId } : {}),
        name,
        status: STATUS_MAP[status],
        startTimeEpochMs: frame.startEpochMs,
        endTimeEpochMs: frame.startEpochMs + durationMs,
        attributes: merged,
      }
      exporter.recordSpan(span)
    },
  }
}

export interface InstalledOtelExport {
  /** The live exporter (host may also feed metrics through it), or null when
   *  export is OFF (env unset). */
  readonly exporter: OtelExporter | null
  /** Final flush + stop timers + restore the previously-registered span sink.
   *  Idempotent-safe to await once at host shutdown. No-throw. */
  readonly teardown: () => Promise<void>
}

/**
 * HOST composition-root entry point. Reads `QUANTA_OTEL_ENDPOINT` (+ the
 * service/batch/flush knobs) and, when set, registers a span sink that exports
 * the loop's spans to the OTLP collector. When the endpoint is unset this is a
 * no-op (byte-identical Default-OFF) and `teardown` does nothing.
 *
 * Idempotent guard: if a span sink is ALREADY registered (a nested run, or a
 * host that wired its own), this does NOT clobber it — it returns a no-op so
 * the outermost owner keeps control.
 */
export const installOtelSpanExportFromEnv = (
  env: Readonly<Record<string, string | undefined>> = {},
  overrides?: Partial<OtelExporterOpts> & ExporterSpanSinkOpts,
): InstalledOtelExport => {
  const NOOP: InstalledOtelExport = { exporter: null, teardown: async () => {} }
  if (getSpanSink() !== null) return NOOP // someone already owns the sink
  const result = attachOtelExporterFromEnv(env, overrides)
  if (result === undefined) return NOOP // QUANTA_OTEL_ENDPOINT unset ⇒ OFF
  const prevSpanSink = getSpanSink()
  const prevMetricSink = getDefaultMetricSink()
  setSpanSink(createExporterSpanSink(result.exporter, overrides))
  // Metric egress: route every sink-less `defaultMetricsRegistry()` to the same
  // exporter (the process-default seam). Spans AND metrics now ship together.
  setDefaultMetricSink(exporterMetricSink(result.exporter))
  return {
    exporter: result.exporter,
    teardown: async () => {
      try {
        await result.exporter.teardown()
      } finally {
        setSpanSink(prevSpanSink)
        setDefaultMetricSink(prevMetricSink)
      }
    },
  }
}
