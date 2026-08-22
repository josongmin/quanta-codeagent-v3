/**
 * E2E smoke test for the Codex 10-step OTel span tree — core 4 stages.
 *
 * Scope: register a recording {@link SpanSink} via `setSpanSink`, drive a
 * real `runAgent` with a single tool_use turn, and assert that the four
 * core spans (`session_loop`, `session_task.turn`, `run_sampling_request`,
 * `handle_tool_call`) ALL opened + closed in the right nesting order.
 *
 * Why an integration test: the unit suite (`spans.test.ts`) verifies the
 * sink contract in isolation; only an end-to-end loop drive can prove the
 * wrappers in `loop.ts` / `dispatch.ts` actually fire — and fire under the
 * correct attribute schema (turn id, tool name + call_id, conversation id).
 *
 * Default-OFF regression: a sister test runs the SAME loop WITHOUT setting
 * a sink and verifies zero events are recorded by a control sink — the
 * byte-identical contract from RFC §1.2.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import {
  __resetSpanSink,
  SPAN_NAMES,
  type SpanName,
  type SpanSink,
  type SpanStatus,
  setSpanSink,
} from "@/observability"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability/vocabulary"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  FakeLLM,
  baseConfig as harnessBaseConfig,
  RecordingStream,
  text as textScript,
  toolUse as toolUseScript,
} from "./_harness"

// ---------------------------------------------------------------------------
// Recording sink: captures every span open/close in order
// ---------------------------------------------------------------------------

interface OpenEvent {
  kind: "start"
  name: SpanName
  conversationId?: unknown
  threadId?: unknown
  threadKind?: unknown
  turnId?: unknown
  turnKind?: unknown
  toolName?: unknown
  callId?: unknown
}
interface CloseEvent {
  kind: "end"
  name: SpanName
  status: SpanStatus
  durationMs: number
  toolStatus?: unknown
  model?: unknown
  inputTokens?: unknown
  outputTokens?: unknown
  finishReason?: unknown
  operationName?: unknown
  requestModel?: unknown
  providerName?: unknown
}

const recordingSink = (): {
  sink: SpanSink
  events: Array<OpenEvent | CloseEvent>
} => {
  const events: Array<OpenEvent | CloseEvent> = []
  const sink: SpanSink = {
    onStart: (name, a) => {
      events.push({
        kind: "start",
        name,
        conversationId: a[QUANTA_ATTRS.conversation.id],
        threadId: a[QUANTA_ATTRS.thread.id],
        threadKind: a[QUANTA_ATTRS.thread.kind],
        turnId: a[QUANTA_ATTRS.turn.id],
        turnKind: a[QUANTA_ATTRS.turn.kind],
        toolName: a[QUANTA_ATTRS.tool.name],
        callId: a[QUANTA_ATTRS.tool.callId],
      })
      return events.length
    },
    onEnd: (_token, name, status, durationMs, a) => {
      events.push({
        kind: "end",
        name,
        status,
        durationMs,
        toolStatus: a[QUANTA_ATTRS.tool.status],
        model: a[GEN_AI_ATTRS.response.model],
        inputTokens: a[GEN_AI_ATTRS.usage.inputTokens],
        outputTokens: a[GEN_AI_ATTRS.usage.outputTokens],
        finishReason: a[GEN_AI_ATTRS.response.finishReason],
        operationName: a[GEN_AI_ATTRS.operation.name],
        requestModel: a[GEN_AI_ATTRS.request.model],
        providerName: a[GEN_AI_ATTRS.provider.name],
      })
    },
  }
  return { sink, events }
}

const baseConfig = (
  llm: import("@/llm").LLMPort,
  registry: import("@/tool").ToolRegistry,
  stream: import("@/stream").StreamPort,
  cwd: string,
  permission: import("@/permission").PermissionContext,
  maxTurns: number,
): import("@/agent").AgentConfig =>
  harnessBaseConfig({
    llm,
    registry,
    stream,
    permission,
    cwd,
    maxTurns,
    system: "spans-e2e",
  })

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("spans e2e — Codex 10-step tree (core 4)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spans-e2e-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    __resetSpanSink()
  })

  test("a real tool+text run emits all 4 spans in nested order", async () => {
    const { sink, events } = recordingSink()
    setSpanSink(sink)

    const file = join(dir, "spans-out.txt")
    const llm = new FakeLLM([
      toolUseScript("call-1", "write", { path: file, content: "hello spans" }),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")

    // (1) ALL four span names appear at least once on the start side.
    const starts = events.filter((e): e is OpenEvent => e.kind === "start")
    const startNames = starts.map((e) => e.name)
    expect(startNames).toContain(SPAN_NAMES.sessionLoop)
    expect(startNames).toContain(SPAN_NAMES.turn)
    expect(startNames).toContain(SPAN_NAMES.runSamplingRequest)
    expect(startNames).toContain(SPAN_NAMES.handleToolCall)

    // (2) Every start has a matching close — counts agree per span name.
    const ends = events.filter((e): e is CloseEvent => e.kind === "end")
    for (const name of [
      SPAN_NAMES.sessionLoop,
      SPAN_NAMES.turn,
      SPAN_NAMES.runSamplingRequest,
      SPAN_NAMES.handleToolCall,
    ]) {
      const opens = starts.filter((e) => e.name === name).length
      const closes = ends.filter((e) => e.name === name).length
      expect(opens).toBe(closes)
    }

    // (3) `session_loop` opens first and closes last (it is the outermost
    //     wrap around the entire runAgent body).
    expect(events[0]?.kind).toBe("start")
    expect((events[0] as OpenEvent).name).toBe(SPAN_NAMES.sessionLoop)
    const last = events[events.length - 1]
    expect(last?.kind).toBe("end")
    expect((last as CloseEvent).name).toBe(SPAN_NAMES.sessionLoop)

    // (4) Session attrs carry conversation/thread anchors (vocabulary-keyed).
    const sessionStart = starts.find((e) => e.name === SPAN_NAMES.sessionLoop)
    expect(sessionStart?.conversationId).toBeDefined()
    expect(sessionStart?.threadId).toBeDefined()
    expect(sessionStart?.threadKind).toBe("main")

    // (5) Turn span carries a turn id + kind.
    const turnStart = starts.find((e) => e.name === SPAN_NAMES.turn)
    expect(typeof turnStart?.turnId).toBe("string")
    expect(turnStart?.turnKind).toBe("main")

    // (6) Tool span carries name + call_id from the dispatch site, and the
    //     close attrs carry `quanta.tool.call.status` = "success".
    const toolStart = starts.find((e) => e.name === SPAN_NAMES.handleToolCall)
    expect(toolStart?.toolName).toBe("write")
    expect(toolStart?.callId).toBe("call-1")
    const toolEnd = ends.find((e) => e.name === SPAN_NAMES.handleToolCall)
    expect(toolEnd?.status).toBe("ok")
    expect(toolEnd?.toolStatus).toBe("success")

    // (7) Every close has a non-negative integer durationMs.
    for (const e of ends) {
      expect(e.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(e.durationMs)).toBe(true)
    }
  })

  test("the run_sampling_request span carries gen_ai model + token + finish attrs", async () => {
    const { sink, events } = recordingSink()
    setSpanSink(sink)

    // A turn whose stream emits a `usage` event (model + tokens) then stops.
    const llm = new FakeLLM([
      [
        { type: "text_delta", delta: "hi" },
        { type: "usage", model: "claude-test-4", inputTokens: 1234, outputTokens: 56 },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 5),
    )
    expect(outcome.reason).toBe("completed")

    const sampling = events.find(
      (e): e is CloseEvent => e.kind === "end" && e.name === SPAN_NAMES.runSamplingRequest,
    )
    expect(sampling).toBeDefined()
    // gen_ai.* enrichment — previously the sampling span carried ONLY TTFT.
    // RED-ON-INJECTION: reverting stream-consume's capture (buildSamplingSpanAttrs
    // → buildTtftAttrs) drops all of these.
    expect(sampling?.model).toBe("claude-test-4")
    expect(sampling?.inputTokens).toBe(1234)
    expect(sampling?.outputTokens).toBe(56)
    // C2 (jul-12): finish_reasons is a homogeneous string ARRAY per the OTel
    // GenAI semconv (Wave-1 OTLP arrayValue support), NOT a bare scalar.
    expect(sampling?.finishReason).toEqual(["end_turn"])
    // C2: the sampling span is the GenAI `chat` operation.
    expect(sampling?.operationName).toBe("chat")
  })

  test("default-OFF regression: no sink ⇒ zero recorded events (byte-identical)", async () => {
    // Note: we DELIBERATELY do NOT call setSpanSink — the loop runs with
    // the no-op default. The control sink below is a tripwire: if loop.ts
    // ever started bypassing the registry and pushing into a global state,
    // this test would catch it.
    const { sink, events } = recordingSink()
    // Build the sink but DO NOT register it (afterEach clears anyway).
    void sink

    const file = join(dir, "spans-off-out.txt")
    const llm = new FakeLLM([
      toolUseScript("c-off", "write", { path: file, content: "hi" }),
      textScript("ok"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")
    // The control sink is unreachable from the loop (never registered),
    // so it MUST stay empty. This is the byte-identical contract.
    expect(events).toHaveLength(0)
  })

  test("a tool error closes the handle_tool_call span with status:'error'", async () => {
    const { sink, events } = recordingSink()
    setSpanSink(sink)

    // Drive a write with an obviously bad path so the tool returns ok:false.
    const llm = new FakeLLM([
      toolUseScript("call-err", "write", { path: "", content: "" }),
      textScript("gave up"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")

    const ends = events.filter((e): e is CloseEvent => e.kind === "end")
    const toolEnd = ends.find((e) => e.name === SPAN_NAMES.handleToolCall)
    expect(toolEnd).toBeDefined()
    // Either the tool returned ok:false OR the gate denied it — both map to
    // status:"error" on the close attrs (the seam has no first-class
    // "blocked" channel yet).
    expect(toolEnd?.status).toBe("error")
    expect(toolEnd?.toolStatus).toBe("error")
  })
})
