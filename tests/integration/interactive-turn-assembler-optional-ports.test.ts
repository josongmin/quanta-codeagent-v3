import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream } from "./_harness"

const root = mkdtempSync(join(tmpdir(), "interactive-turn-assembler-"))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

const driftPatch = [
  "*** Begin Patch",
  "*** Update File: f.txt",
  "@@",
  " unrelated context",
  "-not-present",
  "+replacement",
  "*** End Patch",
].join("\n")

const fixedPatch = [
  "*** Begin Patch",
  "*** Update File: f.txt",
  "@@",
  "-beta",
  "+BETA",
  "*** End Patch",
].join("\n")

const lastUserText = (messages: readonly Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user") continue
    for (const block of message.content) {
      if (block.type === "text") return block.text
    }
  }
  return ""
}

class FastApplyAssemblerLLM implements LLMPort {
  readonly model = "interactive-turn-fast-apply-model"
  sideConversationCalls = 0
  private mainCalls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const prompt = lastUserText(input.messages)
    if (prompt.startsWith("Re-emit the following change as a single V4A patch")) {
      this.sideConversationCalls += 1
      yield { type: "text_delta", delta: fixedPatch }
      yield { type: "message_stop", stop_reason: "end_turn" }
      return
    }
    this.mainCalls += 1
    if (this.mainCalls === 1) {
      yield { type: "tool_use_start", id: "apply-1", name: "apply_patch" }
      yield { type: "tool_use_end", id: "apply-1", input: { patch: driftPatch } }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []

  constructor(readonly model: string) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const withEnvValue = async (
  key: "QUANTA_FAST_APPLY" | "QUANTA_EFFORT_AUTO",
  value: "on" | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    await run()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

const makeWorkspace = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n")
  return dir
}

describe("interactive turn assembler optional-port wire", () => {
  test("QUANTA_FAST_APPLY=on preserves fast-apply fallback through the turnAssembler path", async () => {
    await withEnvValue("QUANTA_FAST_APPLY", "on", async () => {
      const cwd = makeWorkspace("fast-apply")
      const llm = new FastApplyAssemblerLLM()
      const { runtime } = await createRuntimeFromAgentConfigBase({
        base: {
          llm,
          registry: new ToolRegistry(defaultTools),
          stream: new RecordingStream(),
          permission: { mode: "acceptEdits" },
          messages: [],
          system: "test",
          cwd,
          maxTurns: 6,
          signal: new AbortController().signal,
        },
        turnAssembler: buildInteractiveTurnAssembler(),
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      const session = await runtime.createSession({ cwd, permissionMode: "acceptEdits" })
      try {
        await session.input.append("patch the file")
        await session.turn.run()
        expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
        expect(llm.sideConversationCalls).toBe(1)
      } finally {
        await session.close()
        await runtime.close()
      }
    })
  })

  test("QUANTA_EFFORT_AUTO=on preserves classifier escalation through the turnAssembler path", async () => {
    await withEnvValue("QUANTA_EFFORT_AUTO", "on", async () => {
      const cwd = makeWorkspace("effort-auto")
      const llm = new RecordingLLM("interactive-turn-effort")
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
        turnAssembler: buildInteractiveTurnAssembler(),
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
      }
    })
  })
})
