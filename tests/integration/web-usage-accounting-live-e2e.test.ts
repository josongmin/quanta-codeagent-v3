/** Real production daemon → actual TCP WebSocket → production root/child loops
 * → durable SavedSession → HTTP cost readout. Only the LLM is in-memory.
 * No emitted usage injection, facade stub, paid provider, or silent skip. */
import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { CostSurfaceViewWire } from "@/protocol/session"
import { saveSessionById } from "@/session"
import { bootUsageDaemon, until } from "../support/web-usage-accounting-harness"

const KNOWN = "claude-sonnet-4-6"
const CHILD = "COST-CHILD-ONLY"

const textOf = (input: StreamInput) =>
  input.messages
    .flatMap((message) => message.content.map((block) => (block.type === "text" ? block.text : "")))
    .join(" ")

class ScriptedUsageLlm implements LLMPort {
  readonly provider = "anthropic" as const
  readonly model = KNOWN
  readonly seen: string[] = []
  childCalls = 0
  private spawned = false
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const text = textOf(input)
    this.seen.push(text)
    if (text.includes(CHILD)) {
      this.childCalls += 1
      yield* this.answer(500_000, KNOWN, "child completed")
    } else if (text.includes("SPAWN-COST-CHILD") && !this.spawned) {
      this.spawned = true
      yield { type: "usage", inputTokens: 100_000, outputTokens: 0, model: KNOWN }
      yield { type: "tool_use_start", id: "cost-agent-1", name: "agent" }
      yield {
        type: "tool_use_end",
        id: "cost-agent-1",
        input: { prompt: CHILD, fork_turns: "none" },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
    } else if (text.includes("UNKNOWN-COST-MODEL")) {
      yield* this.answer(700, "usage-e2e-unpriced-model", "unpriced completed")
    } else {
      yield* this.answer(1_000_000, KNOWN, "root completed")
    }
  }
  private *answer(inputTokens: number, model: string, text: string): Iterable<StreamEvent> {
    yield { type: "text_delta", delta: text }
    yield { type: "usage", inputTokens, outputTokens: 0, model }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
  async listModels(): Promise<string[]> {
    return [KNOWN]
  }
}

const on = (view: CostSurfaceViewWire) => {
  expect(view.status).toBe("on")
  if (view.status !== "on") throw new Error("accounting unexpectedly off")
  return view
}

/** Produce the attach target through an earlier real daemon lifetime. Its
 * session binding therefore differs from the live source daemon below. */
const persistedTargetFromPriorDaemon = async () => {
  const daemon = await bootUsageDaemon(new ScriptedUsageLlm())
  try {
    const client = await daemon.connect()
    await client.run("TARGET-FIRST-TURN")
    const saved = await daemon.waitSaved(client.sessionId, 1)
    expect(daemon.externalNetworkAttempts()).toBe(0)
    return saved
  } finally {
    await daemon.cleanup()
  }
}

describe("web production usage accounting — HTTP/WS/live attach", () => {
  test("two real turns publish cumulative replacement totals and persist the same book", async () => {
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm)
    try {
      const client = await daemon.connect()
      const first = on(await client.run("FIRST-ROOT-COST"))
      expect(first).toMatchObject({
        calls: 1,
        totalUsd: 3,
        promptTokens: 1_000_000,
        continuityLost: false,
      })
      const second = on(await client.run("SECOND-ROOT-COST"))
      expect(second).toMatchObject({ calls: 2, totalUsd: 6, promptTokens: 2_000_000 })
      const readout = await daemon.cost()
      expect(readout).toMatchObject({ wired: true, isError: false })
      expect(readout.output).toContain("$6.0000")
      expect(readout.output).toContain("2000000")
      expect(llm.seen).toHaveLength(2)
      await daemon.waitSaved(client.sessionId, 2)
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, 30_000)

  test("real child spend is split, and unknown model usage stays explicitly incomplete", async () => {
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm)
    try {
      const client = await daemon.connect()
      const child = on(await client.run("SPAWN-COST-CHILD"))
      expect(llm.childCalls).toBe(1)
      expect(child.calls).toBe(3)
      expect(child.subagentUsd).toBeCloseTo(1.5, 8)
      expect(child.rootUsd).toBeCloseTo(3.3, 8)
      expect(child.totalUsd).toBeCloseTo(4.8, 8)
      expect((await daemon.cost()).output).toContain("root / subagents")
      const unknown = on(await client.run("UNKNOWN-COST-MODEL"))
      expect(unknown.unpricedCalls).toBe(1)
      expect(unknown.totalUsd).toBe(child.totalUsd)
      expect((await daemon.cost()).output).toContain("unpriced calls     1")
      await daemon.waitSaved(client.sessionId, 4)
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, 30_000)

  test("opening a persisted thread replaces the live book, then new spend continues on that target", async () => {
    const target = await persistedTargetFromPriorDaemon()
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm)
    try {
      const client = await daemon.connect()
      expect(client.sessionId).not.toBe(target.meta.id)
      await client.run("SOURCE-FIRST-TURN")
      const targetId = "persisted-usage-target"
      // A real saved production book; no hand-built accounting state.
      await saveSessionById({ ...target.meta, id: targetId }, target, daemon.sessionRoot)
      await client.run("SOURCE-SECOND-TURN")
      await daemon.waitSaved(client.sessionId, 2)
      expect((await daemon.cost()).output).toContain("$6.0000")
      const attached = await daemon.connect(targetId)
      await until(
        async () => (await daemon.cost()).output.includes("$3.0000"),
        "target accounting attach",
      )
      expect((await daemon.cost()).output).not.toContain("$6.0000")
      const next = on(await attached.run("TARGET-NEXT-TURN"))
      expect(next).toMatchObject({ calls: 2, totalUsd: 6, promptTokens: 2_000_000 })
      const persisted = await daemon.waitSaved(targetId, 2)
      expect(JSON.stringify(persisted.messages)).toContain("TARGET-NEXT-TURN")
      const source = await daemon.saved(client.sessionId)
      expect(JSON.stringify(source?.messages)).not.toContain("TARGET-NEXT-TURN")
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, 30_000)

  test("accounting-off survives actual usage as explicit off in WS and HTTP", async () => {
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm, "off")
    try {
      const client = await daemon.connect()
      expect(await client.run("OFF-ROOT-COST")).toEqual({ status: "off" })
      expect(llm.seen).toHaveLength(1)
      const readout = await daemon.cost()
      expect(readout.output).toContain("accounting         off")
      expect(readout.output).not.toContain("$0")
      await until(
        async () => (await daemon.saved(client.sessionId)) !== undefined,
        "off turn persisted",
      )
      expect((await daemon.saved(client.sessionId))?.usageAccounting).toBeUndefined()
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, 30_000)

  test("corrupt attach warns before new spend and the partial-book marker survives another daemon", async () => {
    const original = await persistedTargetFromPriorDaemon()
    const daemon = await bootUsageDaemon(new ScriptedUsageLlm())
    const recovered = await (async () => {
      try {
        await saveSessionById(
          original.meta,
          { ...original, usageAccounting: "{ corrupt" },
          daemon.sessionRoot,
        )
        const client = await daemon.connect(original.meta.id)
        await until(
          async () => (await daemon.cost()).output.includes("prior totals lost"),
          "corrupt target marked before first turn",
        )
        expect((await daemon.cost()).output).toContain("current total is partial")
        const first = on(await client.run("RECOVERED-PARTIAL-FIRST"))
        expect(first).toMatchObject({ calls: 1, totalUsd: 3, continuityLost: true })
        const saved = await daemon.waitSaved(original.meta.id, 1, "{ corrupt")
        expect(daemon.externalNetworkAttempts()).toBe(0)
        return saved
      } finally {
        await daemon.cleanup()
      }
    })()

    const restarted = await bootUsageDaemon(new ScriptedUsageLlm())
    try {
      await saveSessionById(recovered.meta, recovered, restarted.sessionRoot)
      const client = await restarted.connect(recovered.meta.id)
      await until(
        async () => (await restarted.cost()).output.includes("prior totals lost"),
        "partial marker after next daemon attach",
      )
      const before = await restarted.cost()
      expect(before.output).toContain("$3.0000")
      expect(before.output).toContain("current total is partial")
      const next = on(await client.run("RECOVERED-PARTIAL-NEXT"))
      expect(next).toMatchObject({ calls: 2, totalUsd: 6, continuityLost: true })
      await restarted.waitSaved(recovered.meta.id, 2)
      expect(restarted.externalNetworkAttempts()).toBe(0)
    } finally {
      await restarted.cleanup()
    }
  }, 30_000)
})
