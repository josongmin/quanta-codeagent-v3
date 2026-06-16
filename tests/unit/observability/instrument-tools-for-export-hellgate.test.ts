/**
 * HELLGATE — instrumentToolsForExport (the metric-egress gate for tools).
 *
 * The agent composition wraps its tool array with `instrumentToolsForExport`
 * (runner/assemble/tooling.ts). This proves the gate:
 *   - export OFF (no process-default metric sink) ⇒ tools returned VERBATIM
 *     (same refs) — byte-identical, zero wrapping cost.
 *   - export ON (sink set by installOtelSpanExportFromEnv) ⇒ tools wrapped, and
 *     executing one emits `tool.call.total` to the sink.
 *
 * RED-ON-INJECTION (teeth): inverting the gate (always wrap / always verbatim)
 * breaks one of the two cases below.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetDefaultMetricSink,
  setDefaultMetricSink,
} from "@/observability/metrics/in-memory-registry"
import type { MetricSample } from "@/observability/metrics/port"
import { instrumentToolsForExport } from "@/observability"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const fakeTool = (name: string): Tool => ({
  name,
  description: `fake ${name}`,
  inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "done" } }
  },
})

const ctx = (): ToolContext => ({ cwd: "/x", signal: new AbortController().signal })

const drain = async (tool: Tool): Promise<void> => {
  for await (const _ev of tool.execute({}, ctx())) {
    // consume
  }
}

afterEach(() => {
  __resetDefaultMetricSink()
})

describe("HELLGATE: instrumentToolsForExport gate", () => {
  test("export OFF (no sink) ⇒ tools returned VERBATIM (byte-identical)", () => {
    const t = fakeTool("read")
    const out = instrumentToolsForExport([t])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(t) // same reference — not wrapped
  })

  test("export ON (sink set) ⇒ tools wrapped + execution emits tool.call.total", async () => {
    const samples: MetricSample[] = []
    setDefaultMetricSink({ send: (s) => samples.push(s) })

    const t = fakeTool("write")
    const out = instrumentToolsForExport([t])
    expect(out).toHaveLength(1)
    expect(out[0]).not.toBe(t) // wrapped (new object)
    expect(out[0]?.name).toBe("write") // ...but name preserved (originMap-safe)

    await drain(out[0] as Tool)

    const total = samples.find((s) => s.name === "tool.call.total")
    expect(total).toBeDefined()
    expect(total?.labels?.tool).toBe("write")
    expect(total?.labels?.ok).toBe("true")
    // duration histogram also recorded
    expect(samples.some((s) => s.name === "tool.call.duration_ms")).toBe(true)
  })

  test("a verbatim (OFF) tool executes normally — no metric leaks to a later sink", async () => {
    const t = fakeTool("grep")
    const out = instrumentToolsForExport([t]) // OFF ⇒ verbatim
    // NOW set a sink — the already-returned verbatim tool must NOT emit to it.
    const samples: MetricSample[] = []
    setDefaultMetricSink({ send: (s) => samples.push(s) })
    await drain(out[0] as Tool)
    expect(samples).toHaveLength(0) // verbatim tool has no instrument bound
  })
})
