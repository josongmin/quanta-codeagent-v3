/**
 * ADVERSARIAL HELLAUDIT (integration, attack #1) — prove the WAVES COMPOSE:
 * `QUANTA_TRACE_CONTEXT=1` (NO OTLP endpoint) → `bootBenchOtelExport` installs the
 * context-only span sink → `withActiveSpanScope` installs the issued ref → BOTH
 * the OBSERVE recorder (`JsonlRecorder`, wired as `observe.ts`) AND the CASSETTE
 * (`recordingLlmPort`, wired as `trajectory.ts` with the REAL
 * `@/observability` `getActiveTraceRef`) stamp the SAME `{traceId,spanId}` → the
 * trajectory viewer's `buildSpanTree` JOINS them with `unified===true`.
 *
 * The existing `bench-context-only-sink-wiring.test.ts` only drives the OBSERVE
 * plane and merely COMMENTS that `buildSpanTree(...).unified===true` — it never
 * imports/calls it, and never drives the cassette plane. This closes that gap:
 * it runs the cassette turn under the SAME async scope as an OBSERVE llm_request,
 * then executes a FAITHFUL PORT of the viewer's `buildSpanTree` (index.html:1146
 * `isUnifiedId` + :1166 `buildSpanTree` + :1151 `spanKindLabel`) over the two
 * planes and asserts the tree unifies on ONE trace id.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withActiveSpanScope } from "@/agent/session-resources"
import { bootBenchOtelExport } from "@/apps/bench/otel"
import { withBenchInstanceRoot } from "@/apps/bench/run-main-helpers"
import type { LLMPort } from "@/llm/ports"
import { recordingLlmPort } from "@/llm/replay/recording-llm"
import type { RecordedInteraction, ReplayStore } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { getActiveTraceRef, getSpanSink } from "@/observability"
import { __resetSpanSink, endSpan, SPAN_NAMES, type Span, startSpan } from "@/observability/spans"
import type { RunContext } from "@/shared"
import type { AgentEvent } from "@/stream"
import { JsonlRecorder } from "@/stream/adapters/jsonl-recorder"

const bootOpts = {
  flushIntervalMs: 0,
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}

const tmpDirs: string[] = []
const mkFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tvj-"))
  tmpDirs.push(dir)
  return join(dir, "obs.jsonl")
}

afterEach(() => {
  __resetSpanSink()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── cassette fakes ───────────────────────────────────────────────────────────
const fakeLlm = (): LLMPort => ({
  model: "gpt-5",
  provider: "openai",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "message_stop" } as StreamEvent
    }
    return gen()
  },
})
const memStore = (): ReplayStore & { records: RecordedInteraction[] } => {
  const records: RecordedInteraction[] = []
  return {
    records,
    async append(r) {
      records.push(r)
    },
    async match() {
      return null
    },
    async load() {
      return records
    },
    async save() {},
    reset() {},
  }
}
const minimalInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})
async function drain(iter: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ev of iter) {
    // drain
  }
}

interface ObserveLine {
  readonly kind: string
  readonly ts?: number
  readonly traceId?: string
  readonly spanId?: string
  readonly parentSpanId?: string
  readonly data?: Record<string, unknown>
}
const readLines = (file: string): ObserveLine[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as ObserveLine)
    : []

// ── FAITHFUL PORT of tools/trajectory-viewer/index.html buildSpanTree ─────────
const HEX_TRACE = /^[0-9a-f]{32}$/i
const HEX_SPAN = /^[0-9a-f]{16}$/i
const isUnifiedId = (x: unknown): boolean =>
  typeof x === "string" && (HEX_TRACE.test(x) || HEX_SPAN.test(x))
const spanKindLabel = (name: string, evKind?: string): string => {
  const n = String(name || "").toLowerCase()
  if (n.includes("bench.instance") || evKind === "session_start") return "instance"
  if (n.includes("invoke_agent") || evKind === "session_end") return "invoke"
  if (n.includes("turn") || evKind === "turn_start") return "turn"
  if (n.startsWith("chat") || evKind === "llm_request" || evKind === "llm_usage") return "chat"
  if (n.includes("tool") || evKind === "tool_call" || evKind === "tool_result") return "tool"
  return "span"
}
interface ViewerTurn {
  meta?: { traceId?: string; spanId?: string; parentSpanId?: string }
}
interface ViewerInst {
  observe?: ObserveLine[]
  turns: ViewerTurn[]
}
const buildSpanTree = (inst: ViewerInst): { unified: boolean; nodes: Map<string, unknown> } => {
  const nodes = new Map<string, { spanId: string; traceId: string | null }>()
  let sawTrace = false
  const ensure = (spanId: string, traceId?: string): void => {
    if (!nodes.has(spanId)) nodes.set(spanId, { spanId, traceId: traceId || null })
    else {
      const n = nodes.get(spanId)
      if (n && traceId && !n.traceId) n.traceId = traceId
    }
  }
  for (const ev of inst.observe || []) {
    if (!ev.spanId) continue
    if (ev.traceId) sawTrace = true
    spanKindLabel("", ev.kind) // exercise the same classifier the viewer runs
    ensure(ev.spanId, ev.traceId)
  }
  for (const turn of inst.turns) {
    const sid = turn.meta?.spanId
    if (!sid) continue
    if (turn.meta?.traceId) sawTrace = true
    ensure(sid, turn.meta?.traceId)
  }
  const unified = sawTrace && [...nodes.values()].some((n) => isUnifiedId(n.spanId))
  return { unified, nodes }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("tracing waves COMPOSE — cassette + OBSERVE join in buildSpanTree", () => {
  test("QUANTA_TRACE_CONTEXT=1 (no endpoint): BOTH planes carry the SAME trace id; buildSpanTree.unified===true", async () => {
    const env: Record<string, string | undefined> = { QUANTA_TRACE_CONTEXT: "1" }
    const boot = bootBenchOtelExport(env, bootOpts)
    // No exporter installed (no endpoint) but the context-only sink IS live.
    expect(boot.otelExport.exporter).toBeNull()
    expect(getSpanSink()).not.toBeNull()

    const file = mkFile()
    const ctx: RunContext = { runId: "r1", instanceId: "django__django-1", attempt: 0 }
    const rec = new JsonlRecorder(file, {
      ctx,
      strict: true,
      now: () => 1_700_000_000_000,
      getActiveTraceRef, // ← the REAL @/observability seam (as observe.ts wires it)
      traceContextExpected: () => getSpanSink() !== null,
    })
    // The cassette port wired EXACTLY as trajectory.ts (real getActiveTraceRef).
    const store = memStore()
    const cassette = recordingLlmPort({
      inner: fakeLlm(),
      store,
      getActiveTraceRef,
      traceContextExpected: () => getSpanSink() !== null,
    })

    // Drive a real instance: an OBSERVE llm_request event AND the cassette stream
    // both run INSIDE the sampling scope (the seam the real loop uses), so both
    // must read the SAME active ref = the sampling span's id.
    let observeRef: { traceId: string; spanId: string } | undefined
    await withBenchInstanceRoot({ instanceId: ctx.instanceId ?? "", attempt: 0 }, async () => {
      const turnSpan: Span = startSpan(SPAN_NAMES.turn, {})
      await withActiveSpanScope(false, turnSpan, async () => {
        const samplingSpan: Span = startSpan(SPAN_NAMES.runSamplingRequest, {}, "client")
        await withActiveSpanScope(false, samplingSpan, async () => {
          rec.emit({ type: "llm_request", model: "gpt-5" } as AgentEvent)
          observeRef = getActiveTraceRef()
          await drain(cassette.stream(minimalInput()))
        })
        endSpan(samplingSpan, "ok", {})
      })
      endSpan(turnSpan, "ok", {})
    })
    rec.close()

    // Cassette metadata carries the trace ids.
    expect(store.records).toHaveLength(1)
    const meta = store.records[0]?.metadata as Record<string, unknown>
    expect(meta.traceId).toMatch(HEX_TRACE)
    expect(meta.spanId).toMatch(HEX_SPAN)

    // OBSERVE line carries the trace ids.
    const observe = readLines(file)
    const llmReq = observe.find((l) => l.kind === "llm_request")
    expect(llmReq?.traceId).toMatch(HEX_TRACE)
    expect(llmReq?.spanId).toMatch(HEX_SPAN)

    // THE JOIN: both planes stamped the SAME sampling-span id (unified coordinate).
    expect(meta.traceId).toBe(llmReq?.traceId)
    expect(meta.spanId).toBe(observeRef?.spanId)
    expect(meta.spanId).toBe(llmReq?.spanId)

    // THE VIEWER PAYOFF: buildSpanTree over the two planes unifies on ONE trace.
    const inst: ViewerInst = {
      observe,
      turns: [{ meta: meta as NonNullable<ViewerTurn["meta"]> }],
    }
    const tree = buildSpanTree(inst)
    expect(tree.unified).toBe(true)
    // The cassette's chat span id is a node in the joined tree (cross-plane join).
    expect(tree.nodes.has(meta.spanId as string)).toBe(true)
  })

  test("CONTROL: knob OFF (no sink) — cassette + OBSERVE carry NO trace ids ⇒ buildSpanTree.unified===false", async () => {
    const env: Record<string, string | undefined> = {}
    bootBenchOtelExport(env, bootOpts)
    expect(getSpanSink()).toBeNull()

    const file = mkFile()
    const ctx: RunContext = { runId: "r1", instanceId: "i", attempt: 0 }
    const rec = new JsonlRecorder(file, {
      ctx,
      strict: true,
      now: () => 1_700_000_000_000,
      getActiveTraceRef,
      traceContextExpected: () => getSpanSink() !== null,
    })
    const store = memStore()
    const cassette = recordingLlmPort({ inner: fakeLlm(), store, getActiveTraceRef })

    await withBenchInstanceRoot({ instanceId: "i", attempt: 0 }, async () => {
      rec.emit({ type: "llm_request", model: "gpt-5" } as AgentEvent)
      await drain(cassette.stream(minimalInput()))
    })
    rec.close()

    const meta = store.records[0]?.metadata as Record<string, unknown>
    expect("traceId" in meta).toBe(false)
    const observe = readLines(file)
    expect(observe.find((l) => l.kind === "llm_request")?.traceId).toBeUndefined()

    const tree = buildSpanTree({
      observe,
      turns: [{ meta: meta as NonNullable<ViewerTurn["meta"]> }],
    })
    expect(tree.unified).toBe(false)
  })
})
