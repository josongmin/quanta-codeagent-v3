/**
 * §4.4 LIVE-WIRE hellgate — typed agent-kind enforcement reaches the REAL
 * `agent` tool through `buildSubagentBlock` under `QUANTA_SUBAGENT_TYPED_KIND`.
 *
 * Proves the gate is not a dead opt-in: with the gate ON + a named-agent
 * resolver wired on the config, the materialised `agent` tool:
 *   - REJECTS an unknown agent_type (Claude-Code `subagent_type_miss`),
 *   - ACCEPTS + canonicalises a well-known kind ('Plan' → 'plan'),
 *   - ACCEPTS a registered named-agent (from resolver.names()).
 * And with the gate OFF the same unknown type spawns (byte-identical legacy).
 */

import { afterEach, describe, expect, it } from "bun:test"
import type { NamedAgentResolver } from "@/agent/named-agent-registry"
import { buildSubagentBlock } from "@/agent/tier1/subagent"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const completingLLM = (): LLMPort => ({
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "child finished" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

/** A resolver that knows ONE custom agent name. */
const resolverWith = (names: string[]): NamedAgentResolver => ({
  resolve: (t) =>
    names.includes(t)
      ? { agentType: t, system: `persona:${t}`, sourcePath: `/agents/${t}.md` }
      : undefined,
  names: () => names,
})

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: completingLLM(),
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "SYS",
    cwd: "/tmp",
    maxTurns: 2,
    signal: new AbortController().signal,
    subagent: {} as never, // presence flag — buildSubagentBlock reads config.subagent
    ...over,
  }) as AgentConfig

const agentToolOf = (block: ReturnType<typeof buildSubagentBlock>): Tool => {
  const t = block?.extraTools.find((x) => x.name === "agent")
  if (!t) throw new Error("agent tool missing")
  return t
}

const ctx = (): ToolContext =>
  ({ cwd: "/tmp", signal: new AbortController().signal, depth: 0 }) as ToolContext

const runTool = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx())) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const setGate = (on: boolean): void => {
  if (on) process.env["QUANTA_SUBAGENT_TYPED_KIND"] = "1"
  else delete process.env["QUANTA_SUBAGENT_TYPED_KIND"]
  __resetRuntimeConfig()
}

afterEach(() => {
  delete process.env["QUANTA_SUBAGENT_TYPED_KIND"]
  __resetRuntimeConfig()
})

describe("§4.4 typed-kind LIVE wire through buildSubagentBlock", () => {
  it("gate OFF ⇒ unknown agent_type spawns (byte-identical legacy)", async () => {
    setGate(false)
    const block = buildSubagentBlock(baseCfg({ namedAgentResolver: resolverWith([]) }))
    const ev = await runTool(agentToolOf(block), { prompt: "go", agent_type: "totally-unknown" })
    expect(ev.type).toBe("result")
    expect((ev as { result: { ok: boolean } }).result.ok).toBe(true)
  })

  it("gate ON ⇒ unknown agent_type is REJECTED (subagent_type_miss)", async () => {
    setGate(true)
    const block = buildSubagentBlock(baseCfg({ namedAgentResolver: resolverWith([]) }))
    const ev = await runTool(agentToolOf(block), { prompt: "go", agent_type: "totally-unknown" })
    const r = (ev as { result: { ok: boolean; output: string } }).result
    expect(r.ok).toBe(false)
    expect(r.output).toContain("totally-unknown")
  })

  it("gate ON ⇒ well-known kind accepted (canonicalised path completes ok)", async () => {
    setGate(true)
    const block = buildSubagentBlock(baseCfg({ namedAgentResolver: resolverWith([]) }))
    const ev = await runTool(agentToolOf(block), { prompt: "go", agent_type: "Plan" })
    expect((ev as { result: { ok: boolean } }).result.ok).toBe(true)
  })

  it("gate ON ⇒ REGISTERED named-agent accepted via resolver.names()", async () => {
    setGate(true)
    const block = buildSubagentBlock(baseCfg({ namedAgentResolver: resolverWith(["MyReviewer"]) }))
    const ev = await runTool(agentToolOf(block), { prompt: "go", agent_type: "MyReviewer" })
    expect((ev as { result: { ok: boolean } }).result.ok).toBe(true)
  })

  it("gate ON + NO resolver ⇒ well-known still works; custom is a miss", async () => {
    setGate(true)
    const block = buildSubagentBlock(baseCfg())
    const okEv = await runTool(agentToolOf(block), { prompt: "go", agent_type: "review" })
    expect((okEv as { result: { ok: boolean } }).result.ok).toBe(true)
    const missEv = await runTool(agentToolOf(block), { prompt: "go", agent_type: "custom-x" })
    expect((missEv as { result: { ok: boolean } }).result.ok).toBe(false)
  })
})
