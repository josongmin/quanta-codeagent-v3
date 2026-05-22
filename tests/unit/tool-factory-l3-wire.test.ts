import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { type StreamingTurnArgs, streamingTurn } from "@/agent/streaming-dispatch"
import { buildToolInputSeam } from "@/agent/tool-input-streaming"
import type { StreamEvent } from "@/llm"
import { defineTool } from "@/tool/factory"
import { ToolRegistry } from "@/tool/registry"
import type { Tool, ToolContext, ToolEvent } from "@/tool/types"

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })
const noProgress = (): void => undefined

const inputSchema = z.object({ q: z.string() })
type Input = z.infer<typeof inputSchema>

const outputSchema = z.object({ count: z.number(), label: z.string() })
type Output = z.infer<typeof outputSchema>

// =====================================================================
// A. registry.run() — outputSchema + toModelOutput wires (absorb #1).
// =====================================================================
describe("ToolRegistry.run + outputSchema enforcement (L3 wire)", () => {
  const buildTool = (opts: {
    structured?: unknown
    ok?: boolean
    toModelOutput?: (r: { output: string }) => string
  }): Tool<Input, Output> =>
    defineTool<Input, Output>({
      name: "t",
      description: "d",
      inputSchema,
      outputSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      ...(opts.toModelOutput !== undefined ? { toModelOutput: opts.toModelOutput } : {}),
      async *execute() {
        yield {
          type: "result",
          result: {
            ok: opts.ok ?? true,
            output: "ui-output",
            ...(opts.structured !== undefined ? { structured: opts.structured } : {}),
          },
        }
      },
    })

  test("valid structured payload passes through unchanged", async () => {
    const reg = new ToolRegistry([buildTool({ structured: { count: 1, label: "a" } }) as Tool])
    const result = await reg.run("t", { q: "x" }, ctx(), noProgress)
    expect(result.ok).toBe(true)
    expect(result.output).toBe("ui-output")
    expect(result.structured).toEqual({ count: 1, label: "a" })
  })

  test("invalid structured payload becomes ok:false with retry instruction", async () => {
    const reg = new ToolRegistry([buildTool({ structured: { count: "nope" } }) as Tool])
    const result = await reg.run("t", { q: "x" }, ctx(), noProgress)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("failed validation")
    expect(result.output).toContain("Re-issue the call")
  })

  test("missing structured payload (declared outputSchema) becomes ok:false", async () => {
    const reg = new ToolRegistry([buildTool({}) as Tool])
    const result = await reg.run("t", { q: "x" }, ctx(), noProgress)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("failed validation")
  })

  test("toModelOutput replaces output on ok results", async () => {
    const reg = new ToolRegistry([
      buildTool({
        structured: { count: 5, label: "Z" },
        toModelOutput: (r) => `model-view: ${r.output}`,
      }) as Tool,
    ])
    const result = await reg.run("t", { q: "x" }, ctx(), noProgress)
    expect(result.ok).toBe(true)
    expect(result.output).toBe("model-view: ui-output")
  })

  test("toModelOutput is NOT applied when validation failed (ok:false)", async () => {
    const reg = new ToolRegistry([
      buildTool({
        structured: { count: "nope" },
        toModelOutput: () => "must-not-appear",
      }) as Tool,
    ])
    const result = await reg.run("t", { q: "x" }, ctx(), noProgress)
    expect(result.ok).toBe(false)
    expect(result.output).not.toContain("must-not-appear")
    expect(result.output).toContain("failed validation")
  })

  test("tool with neither outputSchema nor toModelOutput is byte-identical", async () => {
    const plain: Tool<Input> = {
      name: "plain",
      description: "d",
      inputSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async *execute() {
        yield { type: "result", result: { ok: true, output: "verbatim" } }
      },
    }
    const reg = new ToolRegistry([plain as Tool])
    const result = await reg.run("plain", { q: "x" }, ctx(), noProgress)
    expect(result).toEqual({ ok: true, output: "verbatim" })
  })
})

// =====================================================================
// B. streaming-dispatch onToolInput seam (absorb #1).
// =====================================================================
describe("streamingTurn.onToolInput seam (L3 wire)", () => {
  const fakeBlock = (id: string) => ({
    block: { type: "tool_result" as const, tool_use_id: id, content: `r-${id}` },
    ok: true,
    preview: `r-${id}`,
  })
  const baseArgs = (events: StreamEvent[]): StreamingTurnArgs => ({
    events: (async function* gen() {
      for (const ev of events) {
        yield ev
        await Promise.resolve()
      }
    })(),
    isConcurrencySafe: () => true,
    dispatch: async (call) => fakeBlock(call.id),
  })

  test("start/delta/available fire in order with correct ids and payloads", async () => {
    const calls: string[] = []
    const seam = {
      start: (id: string, name: string) => calls.push(`start ${id} ${name}`),
      delta: (id: string, delta: string) => calls.push(`delta ${id} ${delta}`),
      available: (id: string, input: unknown) =>
        calls.push(`available ${id} ${JSON.stringify(input)}`),
    }
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "u1", name: "t" },
      { type: "tool_use_delta", id: "u1", delta: '{"q' },
      { type: "tool_use_delta", id: "u1", delta: '":"x"}' },
      { type: "tool_use_end", id: "u1", input: { q: "x" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const r = await streamingTurn({ ...baseArgs(events), onToolInput: seam })
    expect(r.kind).toBe("assembled")
    expect(calls).toEqual([
      "start u1 t",
      'delta u1 {"q',
      'delta u1 ":"x"}',
      'available u1 {"q":"x"}',
    ])
  })

  test("handler errors are swallowed (do not poison the stream)", async () => {
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "u1", name: "t" },
      { type: "tool_use_delta", id: "u1", delta: "{}" },
      { type: "tool_use_end", id: "u1", input: {} },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const seam = {
      start: () => {
        throw new Error("boom-start")
      },
      delta: () => {
        throw new Error("boom-delta")
      },
      available: () => {
        throw new Error("boom-available")
      },
    }
    const r = await streamingTurn({ ...baseArgs(events), onToolInput: seam })
    expect(r.kind).toBe("assembled")
    if (r.kind === "assembled") {
      expect(r.resultBlocks).toHaveLength(1)
    }
  })

  test("absent onToolInput is byte-identical to the pre-wire path", async () => {
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "u1", name: "t" },
      { type: "tool_use_end", id: "u1", input: { q: "y" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const r = await streamingTurn(baseArgs(events))
    expect(r.kind).toBe("assembled")
    if (r.kind === "assembled") {
      expect(r.resultBlocks).toHaveLength(1)
    }
  })
})

// =====================================================================
// C. buildToolInputSeam (registry-bound wire).
// =====================================================================
describe("buildToolInputSeam", () => {
  const buildTool = (
    name: string,
    cb: {
      onInputStart?: () => void
      onInputDelta?: (delta: string) => void
      onInputAvailable?: (input: unknown) => void
    },
  ): Tool<Input> => ({
    name,
    description: "d",
    inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: "ok" } }
    },
    ...(cb.onInputStart !== undefined ? { onInputStart: cb.onInputStart } : {}),
    ...(cb.onInputDelta !== undefined ? { onInputDelta: cb.onInputDelta } : {}),
    ...(cb.onInputAvailable !== undefined ? { onInputAvailable: cb.onInputAvailable } : {}),
  })

  test("routes start/delta/available to the named tool's callbacks", () => {
    const log: string[] = []
    const tool = buildTool("a", {
      onInputStart: () => log.push("start"),
      onInputDelta: (d) => log.push(`delta:${d}`),
      onInputAvailable: (i) => log.push(`avail:${JSON.stringify(i)}`),
    })
    const reg = new ToolRegistry([tool as Tool])
    const seam = buildToolInputSeam(reg)

    seam.start("u1", "a")
    seam.delta("u1", "chunk1")
    seam.delta("u1", "chunk2")
    seam.available("u1", { q: "x" })

    expect(log).toEqual(["start", "delta:chunk1", "delta:chunk2", 'avail:{"q":"x"}'])
  })

  test("delta/available on unknown id is a no-op (never throws)", () => {
    const reg = new ToolRegistry([buildTool("a", { onInputDelta: () => undefined }) as Tool])
    const seam = buildToolInputSeam(reg)
    expect(() => seam.delta("unknown", "x")).not.toThrow()
    expect(() => seam.available("unknown", {})).not.toThrow()
  })

  test("tool without onInput* fields is a no-op (no throw, no error)", () => {
    const reg = new ToolRegistry([buildTool("a", {}) as Tool])
    const seam = buildToolInputSeam(reg)
    expect(() => {
      seam.start("u1", "a")
      seam.delta("u1", "x")
      seam.available("u1", { q: "x" })
    }).not.toThrow()
  })

  test("unknown tool name on start is a graceful no-op", () => {
    const reg = new ToolRegistry([])
    const seam = buildToolInputSeam(reg)
    expect(() => seam.start("u1", "missing")).not.toThrow()
    expect(() => seam.delta("u1", "x")).not.toThrow()
    expect(() => seam.available("u1", {})).not.toThrow()
  })

  test("callback errors are swallowed (defensive)", () => {
    const reg = new ToolRegistry([
      buildTool("a", {
        onInputStart: () => {
          throw new Error("boom")
        },
      }) as Tool,
    ])
    const seam = buildToolInputSeam(reg)
    expect(() => seam.start("u1", "a")).not.toThrow()
  })

  test("memory: id→name mapping is cleared on available", () => {
    const log: string[] = []
    const reg = new ToolRegistry([buildTool("a", { onInputDelta: (d) => log.push(d) }) as Tool])
    const seam = buildToolInputSeam(reg)
    seam.start("u1", "a")
    seam.delta("u1", "live")
    seam.available("u1", {})
    seam.delta("u1", "should-be-dropped")
    expect(log).toEqual(["live"])
  })

  test("leak guard: tombstoned start-without-available entries are LRU-evicted, not leaked", () => {
    // A `start` whose call is tombstoned mid-args never reaches `available`, so
    // its id→name entry would leak. Simulate many such abandoned starts; the
    // map is bounded by an LRU cap, so the OLDEST entries are evicted. We prove
    // eviction behaviourally: after flooding past the cap, the first id's
    // `delta` is a no-op (its entry was reclaimed), while the most-recent id
    // still routes — i.e. memory stayed bounded without dropping a live call.
    const log: string[] = []
    const reg = new ToolRegistry([buildTool("a", { onInputDelta: (d) => log.push(d) }) as Tool])
    const seam = buildToolInputSeam(reg)

    // u-first is the oldest; flood enough fresh ids to push it out of the cap.
    seam.start("u-first", "a")
    for (let i = 0; i < 512; i++) seam.start(`u-${i}`, "a")

    // Oldest entry evicted ⇒ its delta is dropped (no-op).
    seam.delta("u-first", "evicted")
    // A recent entry is still tracked ⇒ its delta routes.
    seam.delta("u-511", "kept")

    expect(log).toEqual(["kept"])
  })
})
