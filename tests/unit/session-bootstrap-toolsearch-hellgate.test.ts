import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { createRunAgentContext } from "@/agent/loop/session-bootstrap"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

const inertLLM: LLMPort = {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const baseCfg = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: inertLLM,
    registry: new ToolRegistry([fakeTool("read"), fakeTool("write")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 2,
    signal: new AbortController().signal,
    ...overrides,
  }) as AgentConfig

describe("createRunAgentContext", () => {
  test("ToolSearch sees the final merged registry, not the pre-merge base catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-skills-"))
    tmpDirs.push(dir)
    await mkdir(join(dir, "demo"), { recursive: true })
    await writeFile(
      join(dir, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill\n---\nDemo body.\n",
    )

    const ctx = await createRunAgentContext(baseCfg({ skills: { dir } }))
    const ts = ctx.cfg.registry.get("ToolSearch") as Tool<{
      query: string
      max_results?: number
    }>
    expect(ts).toBeDefined()

    let output = ""
    for await (const ev of ts.execute(
      { query: "select:Skill,ToolSearch" },
      { cwd: "/repo", signal: new AbortController().signal } as never,
    )) {
      if (ev.type === "result") output = ev.result.output
    }

    expect(ctx.cfg.registry.specs().map((s) => s.name)).toEqual(
      expect.arrayContaining(["Skill", "ToolSearch"]),
    )
    expect(output).toContain("### Skill")
    expect(output).toContain("### ToolSearch")
    expect(output).not.toContain("Unknown: Skill, ToolSearch")
  })
})
