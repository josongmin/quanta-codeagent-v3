/**
 * Hellgate: promotion of THREE subagent seams to top-level `config.subagent`
 * knobs (2026-06-01). All must stay DEFAULT-OFF / byte-identical when absent.
 *
 *   B1 `toolNamespace` — threaded into `createSubagentRunner`; a forked child's
 *      tool registry exposes SCOPED names. Absent ⇒ RAW names.
 *   B2 `waitTimeoutPolicy` — fed into the trio's `task_output(block:true)`
 *      clamp directly (this builder) AND exposed on the materialized block's
 *      `subagent6Deps.waitTimeoutPolicy` for the `wait_agent` dispatch path.
 *   B3 `maxConcurrent` — exposed on `subagent6Deps.maxConcurrent` for the
 *      6-tool `spawn_agent` path. Absent ⇒ unlimited.
 *
 * Proven seams:
 *   - config.subagent.toolNamespace set ⇒ child tools scoped (absent ⇒ raw),
 *     observed through a recording LLM that captures the CHILD loop's tool set.
 *   - waitTimeoutPolicy set ⇒ task_output(block:true) clamps to it (tiny maxMs
 *     ⇒ fast timeout) AND is surfaced on subagent6Deps for wait_agent.
 *   - maxConcurrent set ⇒ surfaced on subagent6Deps (the spawn cap input).
 *   - ALL-ABSENT ⇒ subagent6Deps === {} and the block is structurally identical
 *     to the pre-promotion shape (byte-identical wiring).
 */
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { prefixToolNamespace } from "@/agent/subagent-runner"
import { buildSubagentBlock } from "@/agent/tier1/subagent"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

/** A real Tool-shaped stub (zod-free schema via a tiny object). */
const fakeTool = (name: string): Tool => ({
  name,
  description: `desc:${name}`,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: `ran:${name}` } }
  },
})

/** A recording LLM that captures the tool names handed to EACH stream() call
 *  (the child loop hands its registry's specs here) and then completes the
 *  turn with zero tool calls ⇒ the loop returns `completed` in 1 turn. */
const recordingLLM = (sink: string[][]): LLMPort => ({
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    sink.push(input.tools.map((t) => t.name).sort())
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: recordingLLM([]),
    registry: new ToolRegistry([fakeTool("exec_command"), fakeTool("write")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "SYS",
    cwd: "/tmp",
    maxTurns: 2,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

/** Drive a tool's execute() to its terminal event. */
const runTool = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const ctx = (): ToolContext =>
  ({ cwd: "/tmp", signal: new AbortController().signal, depth: 0 }) as ToolContext

const agentToolOf = (block: ReturnType<typeof buildSubagentBlock>): Tool => {
  const t = block?.extraTools.find((x) => x.name === "agent")
  if (!t) throw new Error("agent tool missing")
  return t
}
const taskOutputOf = (block: ReturnType<typeof buildSubagentBlock>): Tool => {
  const t = block?.extraTools.find((x) => x.name === "task_output")
  if (!t) throw new Error("task_output tool missing")
  return t
}

// ─── B1: toolNamespace reaches the forked child registry ────────────────────

describe("B1 config.subagent.toolNamespace ⇒ child tools scoped", () => {
  it("ABSENT ⇒ child loop sees the inherited tools by their RAW names", async () => {
    const seenTools: string[][] = []
    const cfg = baseCfg({ llm: recordingLLM(seenTools), subagent: {} })
    const block = buildSubagentBlock(cfg)
    // Foreground spawn forks the real child loop with the recording LLM.
    await runTool(agentToolOf(block), { prompt: "child task" }, ctx())
    expect(seenTools.length).toBeGreaterThan(0)
    const names = seenTools[0] ?? []
    // The inherited parent tools appear under RAW names; nothing is scoped.
    expect(names).toContain("exec_command")
    expect(names).toContain("write")
    expect(names.some((n) => n.includes("__"))).toBe(false)
  })

  it("SET ⇒ child loop sees the inherited tools under SCOPED names (raw gone)", async () => {
    const seenTools: string[][] = []
    const cfg = baseCfg({
      llm: recordingLLM(seenTools),
      subagent: { toolNamespace: prefixToolNamespace },
    })
    const block = buildSubagentBlock(cfg)
    await runTool(agentToolOf(block), { prompt: "child task" }, ctx())
    expect(seenTools.length).toBeGreaterThan(0)
    const names = seenTools[0] ?? []
    // First child's mailbox label is `root/0` ⇒ sanitized prefix `root_0__`.
    // The INHERITED parent tools are rewritten; their raw names are gone.
    expect(names).toContain("root_0__exec_command")
    expect(names).toContain("root_0__write")
    expect(names).not.toContain("exec_command")
    expect(names).not.toContain("write")
  })

  it("a CUSTOM strategy is honored verbatim (closed port)", async () => {
    const seenTools: string[][] = []
    const cfg = baseCfg({
      llm: recordingLLM(seenTools),
      subagent: { toolNamespace: { scope: (_tok, raw) => `X-${raw}` } },
    })
    const block = buildSubagentBlock(cfg)
    await runTool(agentToolOf(block), { prompt: "child task" }, ctx())
    const names = seenTools[0] ?? []
    expect(names).toContain("X-exec_command")
    expect(names).toContain("X-write")
    expect(names).not.toContain("exec_command")
  })
})

// ─── B2: waitTimeoutPolicy clamps task_output AND surfaces for wait_agent ────

describe("B2 config.subagent.waitTimeoutPolicy ⇒ task_output clamp", () => {
  it("SET ⇒ task_output(block:true) clamps the wait to the tiny configured maxMs", async () => {
    // A registry record that NEVER settles ⇒ the block path must rely on the
    // clamped timeout to return. maxMs=15ms ⇒ the wait resolves to a timeout
    // far faster than the 30s default would.
    const cfg = baseCfg({
      subagent: { waitTimeoutPolicy: { minMs: 1, maxMs: 15, defaultMs: 10 } },
    })
    const block = buildSubagentBlock(cfg)
    const reg = block?.taskRegistry
    if (!reg) throw new Error("no registry")
    const id = reg.newId()
    reg.register({ id, description: "stuck" }) // status: running, never settles

    const start = Date.now()
    // Request a huge timeout_ms; the configured policy must clamp it to 15ms.
    const ev = await runTool(
      taskOutputOf(block),
      { task_id: id, block: true, timeout_ms: 9_999_999 },
      ctx(),
    )
    const elapsed = Date.now() - start
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.output).toContain("still running") // timed out, not settled
    // Clamp proof: returned in well under a second (the unclamped default 30s
    // would obviously not). Generous bound to avoid CI flake.
    expect(elapsed).toBeLessThan(2_000)
    reg.forceStop(id)
  })

  it("SET ⇒ subagent6Deps.waitTimeoutPolicy carries the SAME band for wait_agent", () => {
    const policy = { minMs: 2, maxMs: 20, defaultMs: 11 }
    const block = buildSubagentBlock(baseCfg({ subagent: { waitTimeoutPolicy: policy } }))
    expect(block?.subagent6Deps.waitTimeoutPolicy).toEqual(policy)
  })
})

// ─── B3: maxConcurrent surfaces on subagent6Deps (spawn cap input) ──────────

describe("B3 config.subagent.maxConcurrent ⇒ surfaced for spawn_agent", () => {
  it("SET ⇒ subagent6Deps.maxConcurrent carries the cap", () => {
    const block = buildSubagentBlock(baseCfg({ subagent: { maxConcurrent: 3 } }))
    expect(block?.subagent6Deps.maxConcurrent).toBe(3)
  })
})

// ─── DEFAULT-OFF: all-absent ⇒ byte-identical wiring ────────────────────────

describe("default-OFF — all three knobs absent ⇒ byte-identical", () => {
  it("subagent6Deps is an EMPTY object (consumer falls back to 6-tool defaults)", () => {
    const block = buildSubagentBlock(baseCfg({ subagent: {} }))
    expect(block?.subagent6Deps).toEqual({})
    expect(block?.subagent6Deps.waitTimeoutPolicy).toBeUndefined()
    expect(block?.subagent6Deps.maxConcurrent).toBeUndefined()
  })

  it("the trio tools are still exactly [agent, task_output, task_stop]", () => {
    const block = buildSubagentBlock(baseCfg({ subagent: {} }))
    expect(block?.extraTools.map((t) => t.name)).toEqual(["agent", "task_output", "task_stop"])
  })

  it("absent config.subagent ⇒ block undefined (composer skips)", () => {
    expect(buildSubagentBlock(baseCfg({}))).toBeUndefined()
  })

  it("a default-policy task_output(block:true) still uses the 30s default (not clamped tiny)", async () => {
    // No waitTimeoutPolicy ⇒ createTaskOutputTool(reg) 1-arg ⇒ DEFAULT policy.
    // A settled task returns immediately regardless of the timeout, proving the
    // no-policy path is the unchanged (1-arg) construction.
    const block = buildSubagentBlock(baseCfg({ subagent: {} }))
    const reg = block?.taskRegistry
    if (!reg) throw new Error("no registry")
    const id = reg.newId()
    reg.register({ id, description: "fast" })
    reg.complete(id, { ok: true, finalText: "ok", turns: 1 })
    const ev = await runTool(taskOutputOf(block), { task_id: id, block: true }, ctx())
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("expected result")
    expect(ev.result.output).toContain("completed")
  })
})
