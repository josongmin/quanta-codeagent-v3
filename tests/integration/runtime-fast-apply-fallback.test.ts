import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream } from "./_harness"

const root = mkdtempSync(join(tmpdir(), "runtime-fast-apply-"))

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

class FastApplyRuntimeLLM implements LLMPort {
  readonly model = "runtime-fast-apply-model"
  mainCalls = 0
  sideConversationCalls = 0

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

const withFastApplyEnv = async (
  value: "on" | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const prev = process.env.QUANTA_FAST_APPLY
  if (value === undefined) delete process.env.QUANTA_FAST_APPLY
  else process.env.QUANTA_FAST_APPLY = value
  __resetRuntimeConfig()
  try {
    await run()
  } finally {
    if (prev === undefined) delete process.env.QUANTA_FAST_APPLY
    else process.env.QUANTA_FAST_APPLY = prev
    __resetRuntimeConfig()
  }
}

const makeWorkspace = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n")
  return dir
}

describe("runtime fast-apply fallback wire", () => {
  test("QUANTA_FAST_APPLY=on wires the runtime fallback and rescues anchor drift once", async () => {
    await withFastApplyEnv("on", async () => {
      const cwd = makeWorkspace("on")
      const llm = new FastApplyRuntimeLLM()
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

  test("QUANTA_FAST_APPLY off keeps the runtime byte-identical and never dispatches fallback", async () => {
    await withFastApplyEnv(undefined, async () => {
      const cwd = makeWorkspace("off")
      const llm = new FastApplyRuntimeLLM()
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
        history: [],
        state: undefined,
        idMeta: undefined,
        shutdown: async () => undefined,
      })
      const session = await runtime.createSession({ cwd, permissionMode: "acceptEdits" })
      try {
        await session.input.append("patch the file")
        await session.turn.run()
        expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nbeta\n")
        expect(llm.sideConversationCalls).toBe(0)
      } finally {
        await session.close()
        await runtime.close()
      }
    })
  })
})
