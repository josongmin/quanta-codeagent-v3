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
import { getActiveTraceRef, type TraceRef } from "./tracing/active-context"
import { hexId } from "./tracing/hex-id"
import type { SpanAttributes, SpanKind, SpanStatusCode } from "./tracing/port"

/** Loop span status → OTLP status code. `aborted` is a non-OK terminal state,
 *  so it maps to `error` (the OTLP code set is unset/ok/error only). */
const STATUS_MAP: Readonly<Record<SpanStatus, SpanStatusCode>> = {
  ok: "ok",
  error: "error",
  aborted: "error",
}

export interface ExporterSpanSinkOpts {
  /** Epoch-ms clock. Default `Date.now`. Test seam. */
  readonly now?: () => number
  /** CSPRNG seam — returns `len` random bytes. Default `crypto.getRandomValues`. */
  readonly randomBytes?: (len: number) => Uint8Array
  /** Fixed 32-hex trace id (test seam). Default: one random trace per sink. */
  readonly traceId?: string
}

/**
 * SHARED parentage authority for every {@link SpanSink} that keeps a direct-path
 * LIFO fallback stack (the exporter sink AND the context-only sink — T-B1).
 *
 * The rule (jul-13 defect fix): the SOLE parent gate is the per-context
 * async-local ref (`getActiveTraceRef`). When a `withActiveSpanScope` installed
 * the enclosing span as the active ref, THAT is the async-safe parent — two
 * concurrently-interleaved sessions read their OWN active ref, so roots never
 * cross-link. The shared LIFO `stack` is consulted ONLY when there is NO active
 * ref for THIS async context (the direct `startSpan`/`endSpan` path), and a
 * frame is PUSHED onto it ONLY on that direct path — a scoped span carries its
 * parentage in its own async context and must NOT enter the shared stack (that
 * lingering is what let concurrent scoped sessions cross-link before). The
 * matching {@link evictScopedFrame} removes a now-scoped frame from the stack.
 *
 * Returns the ISSUED {@link TraceRef} core (`traceId`/`spanId`/`traceFlags`,
 * plus `parentSpanId` iff parented). Both sinks build their own frame around it
 * (the exporter adds start time/attrs/kind; the context-only sink adds nothing).
 *
 * @param stack the sink's shared open-span LIFO fallback (`push` happens here on
 *   the direct path); each entry MUST carry a `TraceRef` shape (`traceId`,
 *   `spanId`, `traceFlags`).
 * @param frame the caller's frame object for THIS span — pushed onto `stack` on
 *   the direct path so a later direct-path child (and {@link evictScopedFrame})
 *   can find it. It MUST already carry the returned ref fields.
 * @param gen CSPRNG byte source (id mint seam).
 * @param fixedTraceId optional fixed root trace (exporter test seam only).
 */
export const resolveSpanParentage = (
  stack: readonly TraceRef[],
  gen: (len: number) => Uint8Array,
  fixedTraceId?: string,
): { readonly ref: TraceRef; readonly pushToStack: boolean } => {
  const activeParent = getActiveTraceRef()
  const parent: TraceRef | undefined =
    activeParent ?? (stack.length > 0 ? stack[stack.length - 1] : undefined)
  // Root (no parent) ⇒ a NEW trace; child ⇒ inherit the parent's trace.
  const traceId = parent?.traceId ?? fixedTraceId ?? hexId(16, gen)
  const ref: TraceRef = {
    spanId: hexId(8, gen),
    traceId,
    traceFlags: parent?.traceFlags ?? 1,
    ...(parent !== undefined ? { parentSpanId: parent.spanId } : {}),
  }
  // Push ONLY the direct path (no active ref) onto the shared stack.
  return { ref, pushToStack: activeParent === undefined }
}

/** Evict a now-scoped frame from a sink's shared direct-path LIFO stack (the
 *  `onScoped` primitive). A token IS its frame; `lastIndexOf`+`splice(idx, 1)`
 *  removes the EXACT frame — never the stragglers above it (a one-arg
 *  `splice(idx)` dropped concurrent siblings). No-ops (idx=-1) for a frame that
 *  was never pushed (a span already scoped at open). Shared by both sinks so the
 *  concurrent-session eviction contract cannot drift between them. */
export const evictScopedFrame = <T>(stack: T[], token: T): void => {
  const idx = stack.lastIndexOf(token)
  if (idx >= 0) stack.splice(idx, 1)
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
    /** OTel SpanKind supplied at OPEN (D3) — CLIENT for the `chat` (sampling)
     *  span, `undefined` (⇒ INTERNAL) for session/turn/tool spans. Carried here
     *  so `onEnd` sets `ExportSpan.kind` and `otlpKind` emits the right OTLP enum
     *  (undefined ⇒ INTERNAL, byte-identical to the pre-D3 flat sink). */
    readonly kind?: SpanKind
  }
  // Open-span stack for parent linkage — the FALLBACK when no active
  // async-context ref encloses the open (the DIRECT-sink path: unit tests +
  // hosts that call startSpan/endSpan without wrapping the body in
  // `withActiveSpanScope`). ONLY direct-path frames are pushed here; SCOPED
  // spans (those with a live active-context ref) never touch this stack, so
  // two concurrent scoped sessions cannot cross-link through it. A token IS its
  // frame, so onEnd removes the EXACT frame (`splice(idx, 1)`) — never the
  // stragglers above it (audit Q2: a one-arg `splice(idx)` dropped concurrent
  // siblings, corrupting the tree whenever tools/subagents close out of LIFO
  // order).
  const open: Frame[] = []

  return {
    onStart(_name: SpanName, attrs, kind?: SpanKind): unknown {
      // Parentage authority (jul-13 defect fix) — the SOLE gate is the
      // per-context async-local ref (see `resolveSpanParentage`, shared with the
      // context-only sink so the two cannot drift). The shared LIFO stack is
      // consulted ONLY on the direct path; scoped spans are kept OUT of it.
      const { ref, pushToStack } = resolveSpanParentage(open, gen, fixedTraceId)
      const frame: Frame = {
        ...ref,
        startEpochMs: now(),
        startAttrs: attrs as SpanAttributes,
        ...(kind !== undefined ? { kind } : {}),
      }
      // Push ONLY the direct path onto the shared stack. A scoped span carries
      // its parentage in its own async context, so it must NOT enter the shared
      // stack — that is what let concurrent scoped sessions cross-link before.
      if (pushToStack) open.push(frame)
      return frame
    },
    onScoped(token: unknown): void {
      // A TOP-LEVEL session root (standalone `runAgent`) opens on the DIRECT path
      // (no active ref yet — its scope is installed one call LATER), so it is
      // pushed onto the shared stack above. The instant `withActiveSpanScope`
      // installs it as the active ref, it BECOMES a scoped span and must leave
      // the shared stack — otherwise a CONCURRENT session's root, opening while
      // this root lingers, would adopt it as parent and collapse two independent
      // traces into one. (Under bench the root is ALREADY scoped by
      // `withBenchInstanceRoot`, so it was never pushed and this evict no-ops
      // via idx=-1 — harmless.) Shared with the context-only sink.
      evictScopedFrame(open, token as Frame)
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
        // D3: carry the OPEN-time SpanKind onto the exported span (undefined ⇒
        // `otlpKind` yields INTERNAL, byte-identical to every pre-D3 span).
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
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
