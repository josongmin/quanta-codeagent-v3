/**
 * D2 (jul-13 tracing off-by-one) — `llm_request` must be stamped with the
 * SAMPLING span's ref, not the enclosing TURN span's.
 *
 * The defect: `emitLlmRequest(...)` used to fire in `streamConsume` BEFORE the
 * `withActiveSpanScope(false, samplingSpan, …)` scope opened — so the OBSERVE
 * recorder (which samples `getActiveTraceRef()` at emit time) stamped
 * `llm_request` with the TURN span's `{traceId, spanId}`. Meanwhile the paired
 * `usage` event (emitted inside `teeUsage`, INSIDE the sampling scope) and the
 * cassette (sampled at `stream()` start, also inside the scope) both got the
 * SAMPLING span's ref. Consequence: `llm_request.spanId !== usage.spanId` under
 * the OTel-ref override — the two never join on `{traceId, spanId}` (C3/C4).
 *
 * This test reproduces the loop timing with a REAL `runAgent` driving a REAL
 * export sink (so `withActiveSpanScope` installs DISTINCT turn vs sampling refs
 * as the active async-context ref). It captures `getActiveTraceRef()` at the
 * exact instant of:
 *   · the `llm_request` stream emit (the recorder's sampling point),
 *   · every `usage` stream emit (the recorder's sampling point), and
 *   · the LLM `stream()` entry (the cassette's sampling point).
 * and asserts all three read the SAME ref — the sampling one.
 *
 * RED-ON-INJECTION: moving `emitLlmRequest(...)` back BEFORE the
 * `withActiveSpanScope` body (its pre-fix position) makes the `llm_request`
 * emit sample the TURN ref instead ⇒ `reqRef.spanId !== usageRef.spanId` ⇒ the
 * first two assertions fail.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetSpanSink, setSpanSink } from "@/observability"
import type { ExportSpan, OtelExporter } from "@/observability/otel-exporter"
import { createExporterSpanSink } from "@/observability/otel-span-export"
import { getActiveTraceRef, type TraceRef } from "@/observability/tracing"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import { baseConfig as harnessBaseConfig } from "./_harness"

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

/** Stream port that samples the ACTIVE trace ref at the moment each
 *  `llm_request` / `usage` event is emitted — exactly what the JsonlRecorder's
 *  `frame()` does via `getActiveTraceRef()`. */
class RefSamplingStream implements StreamPort {
  reqRef: TraceRef | undefined
  usageRefs: (TraceRef | undefined)[] = []
  emit(event: AgentEvent): void {
    if (event.type === "llm_request") this.reqRef = getActiveTraceRef()
    if (event.type === "usage") this.usageRefs.push(getActiveTraceRef())
  }
}

/** LLM double that samples the active ref at `stream()` entry — the cassette's
 *  (`recording-llm.ts`) sampling point, which sits inside the sampling scope. */
class RefSamplingLLM implements LLMPort {
  readonly model = "claude-x"
  readonly provider = "anthropic"
  streamRef: TraceRef | undefined
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.streamRef = getActiveTraceRef()
    const next = this.scripts.shift()
    if (next) this.last = next
    for (const e of next ?? this.last) yield e
  }
}

const cfgFor = (llm: LLMPort, stream: StreamPort, cwd: string): AgentConfig =>
  harnessBaseConfig({
    llm,
    stream,
    sessionId: "s-d2",
    registry: new ToolRegistry(defaultTools),
    permission: { mode: "acceptEdits" } as PermissionContext,
    cwd,
    maxTurns: 3,
    system: "llm-request-sampling-scope",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  })

afterEach(() => {
  __resetSpanSink()
})

describe("D2 — llm_request samples the SAMPLING span ref (not the turn span)", () => {
  test("llm_request, usage, and the cassette all read ONE ref (the sampling span)", async () => {
    const { exporter, spans } = capturingExporter()
    setSpanSink(createExporterSpanSink(exporter))

    const llm = new RefSamplingLLM([
      [
        { type: "text_delta", delta: "hi" },
        { type: "usage", model: "claude-x", inputTokens: 7, outputTokens: 2 },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ])
    const stream = new RefSamplingStream()

    const dir = mkdtempSync(join(tmpdir(), "d2-sampling-"))
    try {
      const outcome = await runAgent(cfgFor(llm, stream, dir))
      expect(outcome.reason).toBe("completed")

      // All three sampling points fired.
      expect(stream.reqRef).toBeDefined()
      expect(stream.usageRefs.length).toBeGreaterThan(0)
      expect(llm.streamRef).toBeDefined()
      const usageRef = stream.usageRefs[0]
      expect(usageRef).toBeDefined()

      // CORE PROOF — the `llm_request` emit read the SAME ref as the `usage`
      // emit. Pre-fix (emit outside the scope) this reads the TURN ref while
      // usage reads the SAMPLING ref ⇒ different spanId ⇒ FAIL.
      expect(stream.reqRef?.spanId).toBe(usageRef?.spanId)
      expect(stream.reqRef?.traceId).toBe(usageRef?.traceId)

      // The cassette's sampled ref (stream() entry) matches too — one identity
      // across OBSERVE (request+usage) and cassette.
      expect(llm.streamRef?.spanId).toBe(usageRef?.spanId)
      expect(llm.streamRef?.traceId).toBe(usageRef?.traceId)

      // And that shared spanId IS a real EXPORTED `run_sampling_request` span —
      // proving the ref is the sampling span, not the turn span.
      const sampling = spans.filter((s) => s.name === "run_sampling_request")
      expect(sampling.some((s) => s.spanId === usageRef?.spanId)).toBe(true)
      // Defensive: it must NOT be a turn span's id (the pre-fix wrong ref).
      const turnSpanIds = new Set(
        spans.filter((s) => s.name === "session_task.turn").map((s) => s.spanId),
      )
      expect(turnSpanIds.has(usageRef?.spanId ?? "")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
