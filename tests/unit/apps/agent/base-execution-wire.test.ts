import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"
import type { Message } from "@/llm"

const mkMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

describe("apps/agent base execution wire", () => {
  const prevOpenAi = process.env.OPENAI_API_KEY

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
  })

  afterEach(() => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAi
  })

  test("delegateModes + forkSession opt-ins produce live ports, not stubs", async () => {
    const base = buildBaseFromArgs({
      mode: "interactive",
      dials: {},
      delegateModes: ["explore"],
      forkSession: true,
    })

    expect(base.delegation).toBeDefined()
    expect(base.fork).toBeDefined()
    expect(base.forkSession).toBeDefined()
    expect(base.conversationCheckpoint).toBeDefined()
    expect(base.delegation?.modes).toEqual(["explore"])

    base.conversationCheckpoint?.store.record("root", [mkMsg("hello")])

    const toolFork = base.fork?.forker.fork("root")
    expect(toolFork?.ok).toBe(true)

    const richFork = await base.forkSession?.forker.fork({ fromCheckpointRef: "root" })
    expect(richFork?.ok).toBe(true)
    if (richFork?.ok) {
      expect(richFork.value.parentSessionId).toBe("root")
      expect(richFork.value.messages.length).toBe(1)
    }
  })
})
