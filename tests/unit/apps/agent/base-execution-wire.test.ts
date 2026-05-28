import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"
import type { Message } from "@/llm"

const mkMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

describe("apps/agent base execution wire", () => {
  const prevOpenAi = process.env.OPENAI_API_KEY
  const prevFastApply = process.env.QUANTA_FAST_APPLY
  const prevEffortAuto = process.env.QUANTA_EFFORT_AUTO

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
    delete process.env.QUANTA_FAST_APPLY
    delete process.env.QUANTA_EFFORT_AUTO
  })

  afterEach(() => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAi
    if (prevFastApply === undefined) delete process.env.QUANTA_FAST_APPLY
    else process.env.QUANTA_FAST_APPLY = prevFastApply
    if (prevEffortAuto === undefined) delete process.env.QUANTA_EFFORT_AUTO
    else process.env.QUANTA_EFFORT_AUTO = prevEffortAuto
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

  test("QUANTA_FAST_APPLY=on + QUANTA_EFFORT_AUTO=on inject optional ports into the CLI base", () => {
    process.env.QUANTA_FAST_APPLY = "on"
    process.env.QUANTA_EFFORT_AUTO = "on"

    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })

    expect(base.roleModelResolver).toBeDefined()
    expect(base.fastApplyFallback).toBeDefined()
    expect(base.effortClassifier).toBeDefined()
  })

  test("optional-port env gates default OFF and keep the CLI base byte-identical", () => {
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })

    expect(base.roleModelResolver).toBeUndefined()
    expect(base.fastApplyFallback).toBeUndefined()
    expect(base.effortClassifier).toBeUndefined()
  })
})
