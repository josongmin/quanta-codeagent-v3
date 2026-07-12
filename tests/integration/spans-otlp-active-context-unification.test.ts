/**
 * ACCEPTANCE (jul-12 OTel-GenAI unification, FINAL integration seam).
 *
 * The gap this seals: `withActiveSpanScope` (session-resources.ts) used to mint
 * its OWN async-context ids via `bridgeHex`, while the OTLP EXPORT path
 * (`createExporterSpanSink`) issued DIFFERENT ids. Result: OBSERVE≡cassette
 * joined, but OTLP≠OBSERVE. The fix makes the EXPORTED span's id BE the active
 * async-context ref — so OTLP ≡ OBSERVE ≡ cassette share one `{traceId, spanId}`.
 *
 * With a REAL export sink (`createExporterSpanSink` over a capturing exporter)
 * driving a real `runAgent`, this asserts:
 *
 *   1. UNIFIED ID — the `TraceRef` that `getActiveTraceRef()` returns INSIDE a
 *      span's body === the `{traceId, spanId}` the exporter SHIPS for that span.
 *      Proven structurally: every CHILD span's active-parent ref (captured at
 *      the child's open) equals its parent's EXPORTED `{traceId, spanId}` — the
 *      only way that holds is if `withActiveSpanScope` installed the exporter's
 *      issued id, not a separate bridge id.
 *   2. ONE TRACE — every nested span of a session shares the session root's
 *      exported traceId.
 *   3. ISOLATION — two concurrently-interleaved sessions get DISTINCT exported
 *      traceIds with NO cross-parenting (a child never adopts the other
 *      session's span as parent).
 *
 * RED-ON-INJECTION: reverting the id-install (making `withActiveSpanScope`
 * mint a fresh bridge id instead of installing `span.ref`) breaks case (1) —
 * the child's active-parent id would no longer equal the parent's exported id.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetSpanSink, SPAN_NAMES, type SpanName, type SpanSink, setSpanSink } from "@/observability"
import type { ExportSpan, OtelExporter } from "@/observability/otel-exporter"
import { createExporterSpanSink } from "@/observability/otel-span-export"
import { getActiveTraceRef, type TraceRef } from "@/observability/tracing"
import type { PermissionContext } from "@/permission"
import { defaultTools, ToolRegistry } from "@/tool"
import { baseConfig as harnessBaseConfig } from "./_harness"

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** LLM double that yields control between every stream event so two concurrent
 *  `runAgent` drives genuinely interleave at the sampling boundary. */
class InterleavingLLM implements LLMPort {
  readonly model: string
  readonly provider: string
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][], model: string, provider: string) {
    this.scripts = scripts
    this.model = model
    this.provider = provider
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const e of next ?? this.last) {
      await tick()
      yield e
    }
  }
}

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

/** Wraps the REAL export sink so we ALSO record, per span-open, the active ref
 *  seen at `onStart` (the enclosing parent scope) and the exporter-issued ref
 *  (`Span.ref` shape) returned by the export sink. The two together prove the
 *  installed active id === the exported id. */
interface OpenRow {
  name: SpanName
  /** Active ref at this span's open — its structural parent scope. */
  activeParent: TraceRef | undefined
  /** The ref the EXPORT sink issued for THIS span (what it will POST). */
  issued: TraceRef | undefined
}
const unifiedSink = (
  inner: SpanSink,
): { sink: SpanSink; opens: OpenRow[] } => {
  const opens: OpenRow[] = []
  const sink: SpanSink = {
    onStart: (name, a) => {
      const activeParent = getActiveTraceRef()
      const token = inner.onStart(name, a)
      const issued =
        token !== null && typeof token === "object" && "traceId" in token && "spanId" in token
          ? (token as unknown as TraceRef)
          : undefined
      opens.push({ name, activeParent, issued })
      return token
    },
    onEnd: (token, name, status, durationMs, a) => inner.onEnd(token, name, status, durationMs, a),
    // Forward the scoped-eviction signal so the wrapped exporter can drop a
    // now-scoped frame from its shared direct-path stack (jul-13 fix: without
    // this the session root lingers and a concurrent root cross-links to it).
    onScoped: (token) => inner.onScoped?.(token),
  }
  return { sink, opens }
}

const cfgFor = (llm: LLMPort, sessionId: string, cwd: string): AgentConfig =>
  harnessBaseConfig({
    llm,
    sessionId,
    registry: new ToolRegistry(defaultTools),
    permission: { mode: "acceptEdits" } as PermissionContext,
    cwd,
    maxTurns: 5,
    system: "otlp-active-context-unification",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  })

const toolTurnThenText = (model: string, provider: string, file: string, id: string): InterleavingLLM =>
  new InterleavingLLM(
    [
      [
        { type: "tool_use_start", id, name: "write" },
        { type: "tool_use_end", id, input: { path: file, content: "x" } },
        { type: "usage", model, inputTokens: 10, outputTokens: 2 },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "usage", model, inputTokens: 3, outputTokens: 1 },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ],
    model,
    provider,
  )

afterEach(() => {
  __resetSpanSink()
})

describe("OTLP ≡ active-context id unification (FINAL seam)", () => {
  test("every child's active-parent ref === its parent's EXPORTED {traceId, spanId} (one trace)", async () => {
    const { exporter, spans } = capturingExporter()
    const { sink, opens } = unifiedSink(createExporterSpanSink(exporter))
    setSpanSink(sink)

    const dir = mkdtempSync(join(tmpdir(), "otlp-unify-"))
    try {
      const outcome = await runAgent(
        cfgFor(toolTurnThenText("claude-x", "anthropic", join(dir, "u.txt"), "call-u"), "s1", dir),
      )
      expect(outcome.reason).toBe("completed")

      // Index exported spans by their issued spanId (unique per span).
      const exportedBySpanId = new Map<string, ExportSpan>()
      for (const s of spans) exportedBySpanId.set(s.spanId, s)
      // Every span the sink OPENED must have exported with the SAME issued id it
      // returned to `withActiveSpanScope` (the unification: issued === exported).
      for (const o of opens) {
        expect(o.issued).toBeDefined()
        const exp = exportedBySpanId.get(o.issued?.spanId ?? "")
        expect(exp).toBeDefined()
        expect(exp?.traceId).toBe(o.issued?.traceId ?? "")
      }

      // CORE PROOF — for every NON-root span, the active ref it saw at open (its
      // parent scope) must equal its PARENT's exported {traceId, spanId}. This
      // only holds if `withActiveSpanScope` installed the exporter-issued id as
      // the active ref (not a separate bridge id).
      const nonRoot = opens.filter((o) => o.name !== SPAN_NAMES.sessionLoop)
      expect(nonRoot.length).toBeGreaterThan(0)
      for (const o of nonRoot) {
        expect(o.activeParent).toBeDefined()
        const parentSpanId = o.activeParent?.spanId ?? ""
        const parentExported = exportedBySpanId.get(parentSpanId)
        // The parent id the child saw is a REAL exported span in this trace.
        expect(parentExported).toBeDefined()
        // And the child's OWN exported span records that exact parentSpanId.
        const childExported = exportedBySpanId.get(o.issued?.spanId ?? "")
        expect(childExported?.parentSpanId).toBe(parentSpanId)
        // Same trace — child + parent share one traceId.
        expect(childExported?.traceId).toBe(parentExported?.traceId)
        expect(o.activeParent?.traceId).toBe(childExported?.traceId)
      }

      // ONE TRACE: every exported span of this single session shares one trace.
      const traceIds = new Set(spans.map((s) => s.traceId))
      expect(traceIds.size).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("two concurrent sessions ⇒ DISTINCT exported traceIds, NO cross-parenting", async () => {
    const { exporter, spans } = capturingExporter()
    const { sink } = unifiedSink(createExporterSpanSink(exporter))
    setSpanSink(sink)

    const dir = mkdtempSync(join(tmpdir(), "otlp-unify-2-"))
    try {
      const [a, b] = await Promise.all([
        runAgent(cfgFor(toolTurnThenText("claude-a", "anthropic", join(dir, "a.txt"), "a"), "sA", dir)),
        runAgent(cfgFor(toolTurnThenText("gpt-b", "openai", join(dir, "b.txt"), "b"), "sB", dir)),
      ])
      expect(a.reason).toBe("completed")
      expect(b.reason).toBe("completed")

      // Exactly TWO exported traces — one per session (no collapse, no third).
      const roots = spans.filter((s) => s.name === SPAN_NAMES.sessionLoop)
      expect(roots.length).toBe(2)
      const traceIds = new Set(spans.map((s) => s.traceId))
      expect(traceIds.size).toBe(2)
      expect(roots[0]?.traceId).not.toBe(roots[1]?.traceId)

      // NO CROSS-PARENTING: every span's parentSpanId (if any) belongs to a span
      // of the SAME trace. A stale-stack cross-link would point a child at the
      // other session's span (different traceId).
      const traceOfSpan = new Map(spans.map((s) => [s.spanId, s.traceId]))
      for (const s of spans) {
        if (s.parentSpanId === undefined) continue
        expect(traceOfSpan.get(s.parentSpanId)).toBe(s.traceId)
      }
      // Each root has NO parent.
      for (const r of roots) expect(r.parentSpanId).toBeUndefined()

      // Every trace partition carries its own turn + sampling + tool spans.
      for (const tid of traceIds) {
        const names = spans.filter((s) => s.traceId === tid).map((s) => s.name)
        expect(names).toContain(SPAN_NAMES.turn)
        expect(names).toContain(SPAN_NAMES.runSamplingRequest)
        expect(names).toContain(SPAN_NAMES.handleToolCall)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // D3 (GenAI semconv): the `run_sampling_request` (`chat`) span calls an
  // EXTERNAL LLM, so it MUST export as CLIENT (`kind === "client"` ⇒ otlp code 3).
  // Every SIBLING loop span (session/turn/tool) stays INTERNAL (`kind`
  // undefined ⇒ otlp code 1). RED-ON-INJECTION: reverting the
  // `startSpan(SPAN_NAMES.runSamplingRequest, attrs({}), "client")` back to the
  // 2-arg form (or dropping the kind thread-through in spans.ts /
  // otel-span-export.ts) leaves the sampling span's kind undefined and this
  // `toBe("client")` fails.
  test("chat/sampling span exports kind=client; session/turn/tool stay INTERNAL", async () => {
    const { exporter, spans } = capturingExporter()
    setSpanSink(createExporterSpanSink(exporter))

    const dir = mkdtempSync(join(tmpdir(), "otlp-kind-"))
    try {
      const outcome = await runAgent(
        cfgFor(toolTurnThenText("claude-k", "anthropic", join(dir, "k.txt"), "call-k"), "sK", dir),
      )
      expect(outcome.reason).toBe("completed")

      const sampling = spans.filter((s) => s.name === SPAN_NAMES.runSamplingRequest)
      expect(sampling.length).toBeGreaterThan(0)
      // The chat span is CLIENT — the load-bearing assertion.
      for (const s of sampling) expect(s.kind).toBe("client")

      // Siblings carry NO kind ⇒ otlpKind maps undefined → INTERNAL (byte-identical
      // to the pre-D3 flat sink). A leaked "client" onto a session/turn/tool span
      // would fail here.
      const siblings = spans.filter((s) => s.name !== SPAN_NAMES.runSamplingRequest)
      const sessionTurnTool = siblings.filter(
        (s) =>
          s.name === SPAN_NAMES.sessionLoop ||
          s.name === SPAN_NAMES.turn ||
          s.name === SPAN_NAMES.handleToolCall,
      )
      expect(sessionTurnTool.length).toBeGreaterThan(0)
      for (const s of siblings) expect(s.kind).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
