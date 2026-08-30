/**
 * A1 hellgate — the ROOT's live gauge ignores subagent traffic.
 *
 * Parent and child share ONE stream, so the indicator port receives the
 * child's `usage` and `output_progress` alongside the root's. Before this
 * guard, a subagent's 500k-token call OVERWROTE the parent's "· N tokens"
 * live count and fed the /context reasoning observer — the root's gauge
 * showed the child's request. The event's own provenance is the only thing
 * that can tell them apart, and now it does.
 *
 * The tolerance arm matters as much as the block: events WITHOUT agentKind
 * (legacy or synthetic producers) must keep flowing, or every non-loop
 * emitter of a gauge event silently loses its display.
 */
import { describe, expect, test } from "bun:test"
import { TokenBaselineBox } from "@/agent/compaction"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { teeUsage } from "@/agent/loop/stream-consume"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import { buildIndicatorPort } from "@/apps/cli/repl/factories/indicator-stream-port"
import type { StreamEvent } from "@/llm"
import type { AgentEvent } from "@/stream/types"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const makeHarness = () => {
  const updates: Array<{ inputTokens?: number; outputTokens?: number }> = []
  const observed: Array<{ reasoningTokens?: number }> = []
  const port = buildIndicatorPort(
    {
      start: () => undefined,
      stop: () => undefined,
      updateUsage: (d) => void updates.push(d),
      markFirstChunk: () => undefined,
    },
    { observeUsage: (u) => void observed.push(u) },
  )
  return { port, updates, observed }
}

describe("A1 — subagent events must NOT move the root gauge", () => {
  test("subagent usage does not reach updateUsage or observeUsage", () => {
    const { port, updates, observed } = makeHarness()
    port.emit({
      type: "usage",
      inputTokens: 500_000,
      outputTokens: 9_000,
      reasoningTokens: 42,
      model: "m",
      agentId: "child-1",
      agentKind: "subagent",
    } as AgentEvent)
    expect(updates).toEqual([])
    expect(observed).toEqual([])
  })

  test("subagent output_progress does not reach updateUsage", () => {
    const { port, updates } = makeHarness()
    port.emit({
      type: "output_progress",
      outputTokens: 777,
      exact: true,
      agentKind: "subagent",
    } as AgentEvent)
    expect(updates).toEqual([])
  })
})

describe("A1 wiring proof — the LOOP stamps the provenance the guard reads", () => {
  const drive = async (depth: number | undefined) => {
    const events: AgentEvent[] = []
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: (e: AgentEvent) => void events.push(e) },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "s",
      ...(depth !== undefined ? { depth, mailboxAgentId: "child-1" } : {}),
    } as unknown as AgentConfig
    const src = (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "output_progress", outputTokens: 777, exact: true } as StreamEvent
    })()
    // Drain the SHIPPED tee — the only place the loop re-emits the live feed.
    for await (const _ of teeUsage(
      config,
      src,
      undefined,
      undefined,
      undefined,
      new TokenBaselineBox(),
      0,
    )) {
      // events observed via config.stream
    }
    return events.filter((e) => e.type === "output_progress") as Array<{
      agentKind?: string
    }>
  }

  test("a subagent config's re-emit carries agentKind=subagent", async () => {
    const emitted = await drive(1)
    expect(emitted).toHaveLength(1)
    // Without the stamp the tolerance arm would wave the child through the
    // gauge — the guard is only as real as this field.
    expect(emitted[0]?.agentKind).toBe("subagent")
  })

  test("a root config's re-emit carries agentKind=root", async () => {
    const emitted = await drive(undefined)
    expect(emitted[0]?.agentKind).toBe("root")
  })
})

describe("A1 controls — everything else keeps flowing", () => {
  test("root usage and progress pass", () => {
    const { port, updates, observed } = makeHarness()
    port.emit({
      type: "usage",
      inputTokens: 100,
      outputTokens: 5,
      reasoningTokens: 1,
      model: "m",
      agentId: "root",
      agentKind: "root",
    } as AgentEvent)
    port.emit({
      type: "output_progress",
      outputTokens: 6,
      exact: false,
      agentKind: "root",
    } as AgentEvent)
    expect(updates).toHaveLength(2)
    expect(observed).toEqual([{ reasoningTokens: 1 }])
  })

  test("agentKind-less legacy events pass (tolerance, not enforcement)", () => {
    const { port, updates } = makeHarness()
    port.emit({ type: "usage", inputTokens: 10, outputTokens: 1, model: "m" } as AgentEvent)
    port.emit({ type: "output_progress", outputTokens: 2, exact: true } as AgentEvent)
    expect(updates).toHaveLength(2)
  })

  test("the UPSTREAM stream still receives the child's events (only the gauge filters)", () => {
    // The guard is at the indicator, not the stream: recorders and the
    // accounting authority must keep seeing subagent traffic.
    const events: AgentEvent[] = []
    const parent = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: (e: AgentEvent) => void events.push(e) },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "s",
    } as unknown as AgentConfig
    const child = buildChildConfig(parent, { prompt: "x" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)
    emitUsage(
      child,
      { type: "usage", model: "m", inputTokens: 500, outputTokens: 0 } as UsageEv,
      undefined,
      undefined,
      undefined,
    )
    const usage = events.filter((e) => e.type === "usage")
    expect(usage).toHaveLength(1)
    expect((usage[0] as { agentKind?: string }).agentKind).toBe("subagent")
  })
})
