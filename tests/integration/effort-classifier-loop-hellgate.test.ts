import { describe, expect, test } from "bun:test"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { type AgentConfig, runAgent } from "@/agent"
import { createEffortClassifier } from "@/agent/effort-classifier"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { defaultTools, defineTool, ToolRegistry } from "@/tool"
import { RecordingStream } from "./_harness"

class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0

  constructor(
    readonly model: string,
    private readonly scripts: StreamEvent[][],
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const next = this.scripts[Math.min(this.calls - 1, this.scripts.length - 1)]
    if (next === undefined) throw new Error("script exhausted")
    for (const event of next) yield event
  }
}

const finishText = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const invokeTool = (id: string, name: string, input: unknown = {}): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const invokeSkill = (id: string, name: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "Skill" },
  { type: "tool_use_end", id, input: { name } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const failTool = defineTool({
  name: "fail_tool",
  description: "always fails",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute() {
    yield { type: "result", result: { ok: false, output: "fail-tool-error" } }
  },
})

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm" | "cwd">): AgentConfig => ({
  registry: new ToolRegistry([...defaultTools, failTool]),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" },
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  system: "test",
  maxTurns: 8,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withEffortEnv = async (value: "on" | undefined, run: () => Promise<void>): Promise<void> => {
  const prev = process.env.QUANTA_EFFORT_AUTO
  if (value === undefined) delete process.env.QUANTA_EFFORT_AUTO
  else process.env.QUANTA_EFFORT_AUTO = value
  __resetRuntimeConfig()
  try {
    await run()
  } finally {
    if (prev === undefined) delete process.env.QUANTA_EFFORT_AUTO
    else process.env.QUANTA_EFFORT_AUTO = prev
    __resetRuntimeConfig()
  }
}

describe("effort classifier loop wire", () => {
  test("QUANTA_EFFORT_AUTO=on escalates an ultrathink prompt to max on the first runtime turn", async () => {
    await withEffortEnv("on", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "effort-auto-on-"))
      const llm = new RecordingLLM("runtime-effort", [finishText("done")])
      const { runtime } = await createRuntimeFromAgentConfigBase({
        base: {
          llm,
          registry: new ToolRegistry(defaultTools),
          stream: new RecordingStream(),
          permission: { mode: "default" },
          messages: [],
          system: "test",
          cwd,
          maxTurns: 4,
          signal: new AbortController().signal,
        },
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      const session = await runtime.createSession({ cwd, permissionMode: "default" })
      try {
        await session.input.append("ultrathink through this")
        await session.turn.run()
        expect(llm.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 64000 })
      } finally {
        await session.close()
        await runtime.close()
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  test("classifier absent keeps an ultrathink prompt byte-identical (no thinking field)", async () => {
    await withEffortEnv(undefined, async () => {
      const llm = new RecordingLLM("base", [finishText("done")])
      const cwd = mkdtempSync(join(tmpdir(), "effort-auto-off-"))
      try {
        await runAgent(
          cfg({
            llm,
            cwd,
            messages: [
              { role: "user", content: [{ type: "text", text: "ultrathink through this" }] },
            ],
          }),
        )
        expect(llm.inputs[0]?.thinking).toBeUndefined()
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  test("three executed tool failures escalate the next sampling request to high", async () => {
    const llm = new RecordingLLM("base", [
      invokeTool("f1", "fail_tool", { attempt: 1 }),
      invokeTool("f2", "fail_tool", { attempt: 2 }),
      invokeTool("f3", "fail_tool", { attempt: 3 }),
      finishText("done"),
    ])
    const cwd = mkdtempSync(join(tmpdir(), "effort-failures-"))
    try {
      await runAgent(
        cfg({
          llm,
          cwd,
          effortClassifier: createEffortClassifier(),
        }),
      )
      expect(llm.inputs[0]?.thinking).toBeUndefined()
      expect(llm.inputs[1]?.thinking).toBeUndefined()
      expect(llm.inputs[2]?.thinking).toBeUndefined()
      expect(llm.inputs[3]?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("skill effort 0 remains explicit-off even when the classifier recommends max", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "effort-explicit-off-"))
    const classifier = createEffortClassifier()
    classifier.onUserPrompt("ultrathink this")
    const llm = new RecordingLLM("base", [invokeSkill("s1", "zero"), finishText("done")])
    try {
      await mkdir(join(cwd, "zero"), { recursive: true })
      await writeFile(
        join(cwd, "zero", "SKILL.md"),
        "---\nname: zero\ndescription: explicit off\neffort: 0\n---\nno think\n",
      )
      await runAgent(
        cfg({
          llm,
          cwd,
          skills: { dir: cwd },
          effortClassifier: classifier,
        }),
      )
      expect(llm.inputs[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 64000 })
      expect(llm.inputs[1]?.thinking).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
