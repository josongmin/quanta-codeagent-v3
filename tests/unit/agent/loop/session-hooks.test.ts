import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent/hooks"
import { emitUserPromptSubmitHook, summarizeUserPrompt } from "@/agent/loop/session-hooks"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

const stubStream = (): StreamPort => ({ emit: () => {} })

const baseConfig = (hooks?: AgentConfig["hooks"]): AgentConfig => ({
  llm: { stream: async function* () {} },
  registry: new ToolRegistry([]),
  stream: stubStream(),
  permission: { mode: "default" },
  messages: [],
  system: "",
  cwd: "/tmp",
  maxTurns: 1,
  signal: new AbortController().signal,
  ...(hooks !== undefined ? { hooks } : {}),
})

describe("session-hooks", () => {
  test("summarizeUserPrompt joins text blocks and counts attachments", () => {
    const summary = summarizeUserPrompt({
      role: "user",
      content: [
        { type: "text", text: "one" },
        { type: "image", image: "data:image/png;base64,abc" },
        { type: "text", text: "two" },
      ],
    } as Message)
    expect(summary).toEqual({ promptText: "one\ntwo", attachmentsCount: 1 })
  })

  test("emitUserPromptSubmitHook rewrites the trailing user prompt", async () => {
    const wm = createWorkingMemory<Message>([
      { role: "assistant", content: [{ type: "text", text: "prior" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "original" },
          { type: "text", text: "tail" },
        ],
      },
    ])
    const hooks = new HookBus()
    hooks.on("user_prompt_submit", () => ({ updatedPrompt: "rewritten" }))
    const cfg = baseConfig(hooks)

    const denied = await emitUserPromptSubmitHook(cfg, wm, "session-1")

    expect(denied).toBeNull()
    const last = wm.snapshot().at(-1)
    expect(last).toEqual({
      role: "user",
      content: [
        { type: "text", text: "rewritten" },
        { type: "text", text: "tail" },
      ],
    })
  })

  test("emitUserPromptSubmitHook returns deny reason without mutating prompt", async () => {
    const original: Message = {
      role: "user",
      content: [{ type: "text", text: "blocked" }],
    }
    const wm = createWorkingMemory<Message>([original])
    const hooks = new HookBus()
    hooks.on("user_prompt_submit", () => ({ deny: "policy" }))
    const cfg = baseConfig(hooks)

    const denied = await emitUserPromptSubmitHook(cfg, wm, "session-1")

    expect(denied).toBe("policy")
    expect(wm.snapshot()[0]).toEqual(original)
  })
})
