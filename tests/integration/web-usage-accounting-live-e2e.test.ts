/** Real production daemon → TCP WebSocket → production root/child loops →
 * durable SavedSession → HTTP cost readout. Only the LLM is in-memory. */
import { describe, expect, spyOn, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
} from "@/observability/usage-accounting"
import type { CostSurfaceViewWire } from "@/protocol/session"
import { saveSessionById } from "@/session"
import {
  bootUsageDaemon,
  renderSnapshotHeader,
  until,
} from "../support/web-usage-accounting-harness"
import { pressureScaledTimeoutMs } from "./_host-pressure"

const KNOWN = "claude-sonnet-4-6"
const CHILD = "COST-CHILD-ONLY"
const HOSTILE_MODEL = `bad\n\u001b[31m${"x".repeat(2_000)}`
const TEST_TIMEOUT_MS = pressureScaledTimeoutMs(30_000)

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
    } else if (text.includes("HOSTILE-COST-MODEL")) {
      yield* this.answer(700, HOSTILE_MODEL, "hostile label completed")
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

const historicalEstimate = (sessionId: string): string => {
  const accounting = createUsageAccounting()
  const provenance = { sessionId, agentId: "root", agentKind: "root" as const, depth: 0 }
  const usage = normalizeUsage({
    model: "historical-estimated-model",
    inputTokens: 1_000_000,
    outputTokens: 0,
  })
  expect(
    accounting.record({
      callId: accounting.mintCallId(provenance),
      at: 1,
      provenance,
      usage,
      cost: priceUsage(usage, MODEL_RATE_CARD, {
        pricingVersion: PRICING_VERSION,
        fallbackModel: KNOWN,
      }),
    }),
  ).toEqual({ admitted: true })
  return accounting.serialize()
}

describe("web production usage accounting — HTTP/WS/live attach", () => {
  test("production attach prepares books before the transcript swap, then commits once", async () => {
    const original = await persistedTargetFromPriorDaemon()
    const order: string[] = []
    const restore: Array<() => void> = []
    const daemon = await bootUsageDaemon(new ScriptedUsageLlm(), "on", (runtime) => {
      const accounting = (runtime as { usageAccounting?: UsageAccountingPort }).usageAccounting
      if (accounting === undefined) throw new Error("production authority missing")
      const prepare = accounting.prepareHydrate.bind(accounting)
      const preparedSpy = spyOn(accounting, "prepareHydrate").mockImplementation((...args) => {
        order.push("prepare")
        const prepared = prepare(...args)
        expect(accounting.snapshot().calls).toBe(0)
        return {
          ...prepared,
          commit: () => {
            order.push("commit")
            prepared.commit()
          },
        }
      })
      restore.push(() => preparedSpy.mockRestore())
      const create = runtime.createSession.bind(runtime)
      const createSpy = spyOn(runtime, "createSession").mockImplementation(async (...args) => {
        const session = await create(...args)
        const replace = session.transcript.replace.bind(session.transcript)
        const replaceSpy = spyOn(session.transcript, "replace").mockImplementation((...input) => {
          order.push("transcript")
          expect(order).toEqual(["prepare", "transcript"])
          expect(accounting.snapshot().calls).toBe(0)
          return replace(...input)
        })
        restore.push(() => replaceSpy.mockRestore())
        return session
      })
      restore.push(() => createSpy.mockRestore())
    })
    try {
      await saveSessionById(original.meta, original, daemon.sessionRoot)
      await daemon.connect(original.meta.id)
      await until(() => order.includes("commit"), "prepared accounting commit")
      expect(order).toEqual(["prepare", "transcript", "commit"])
      expect((await daemon.cost()).output).toContain("$3.0000")
    } finally {
      await daemon.cleanup()
      for (const undo of restore.reverse()) undo()
    }
  }, TEST_TIMEOUT_MS)

  test("two turns publish cumulative replacement totals and persist the same book", async () => {
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm)
    try {
      const client = await daemon.connect()
      expect(on(await client.run("FIRST-ROOT-COST"))).toMatchObject({
        calls: 1,
        totalUsd: 3,
        promptTokens: 1_000_000,
        continuityLost: false,
      })
      expect(on(await client.run("SECOND-ROOT-COST"))).toMatchObject({
        calls: 2,
        totalUsd: 6,
        promptTokens: 2_000_000,
      })
      expect((await daemon.cost()).output).toContain("$6.0000")
      await daemon.waitSaved(client.sessionId, 2)
      expect(llm.seen).toHaveLength(2)
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test("child spend is split and unknown model usage stays explicitly incomplete", async () => {
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm)
    try {
      const client = await daemon.connect()
      const child = on(await client.run("SPAWN-COST-CHILD"))
      expect(llm.childCalls).toBe(1)
      expect(child.calls).toBe(3)
      expect(child.subagentUsd).toBeCloseTo(1.5, 8)
      expect(child.rootUsd).toBeCloseTo(3.3, 8)
      const unknown = on(await client.run("UNKNOWN-COST-MODEL"))
      expect(unknown.unpricedCalls).toBe(1)
      expect(unknown.totalUsd).toBe(child.totalUsd)
      expect((await daemon.cost()).output).toContain("unpriced calls     1")
      await daemon.waitSaved(client.sessionId, 4)
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test("attach replaces the live book and publishes target snapshots to peers", async () => {
    const target = await persistedTargetFromPriorDaemon()
    const daemon = await bootUsageDaemon(new ScriptedUsageLlm())
    try {
      const client = await daemon.connect()
      await client.run("SOURCE-FIRST-TURN")
      const targetId = "persisted-usage-target"
      await saveSessionById(
        { ...target.meta, id: targetId },
        {
          ...target,
          objective: {
            version: 2,
            threads: [{ threadId: target.meta.id, revision: 7, objective: null }],
          },
        },
        daemon.sessionRoot,
      )
      await client.run("SOURCE-SECOND-TURN")
      await daemon.waitSaved(client.sessionId, 2)
      const snapshotsBeforeAttach = client.frames.filter(
        (frame) => frame.kind === "snapshot",
      ).length
      const resumeFromSeq = client.events().at(-1)?.seq ?? client.snapshot().seq
      const attached = await daemon.connect(targetId)
      await until(async () => (await daemon.cost()).output.includes("$3.0000"), "target attach")
      await until(
        () =>
          client.frames.filter((frame) => frame.kind === "snapshot").length > snapshotsBeforeAttach,
        "existing peer target snapshot",
      )
      expect(await renderSnapshotHeader(attached.snapshot())).toContain("$3.00")
      expect(await renderSnapshotHeader(client.snapshot())).toContain("$3.00")
      const resumed = await daemon.connect(undefined, resumeFromSeq)
      expect(await renderSnapshotHeader(resumed.snapshot())).toContain("$3.00")
      expect(on(await attached.run("TARGET-NEXT-TURN"))).toMatchObject({ calls: 2, totalUsd: 6 })
      await daemon.waitSaved(targetId, 2)
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test("accounting-off survives usage as explicit off in WS, snapshots and HTTP", async () => {
    const llm = new ScriptedUsageLlm()
    const daemon = await bootUsageDaemon(llm, "off")
    try {
      const client = await daemon.connect()
      expect(await renderSnapshotHeader(client.snapshot())).toContain(">off</span>")
      expect(await client.run("OFF-ROOT-COST")).toEqual({ status: "off" })
      expect((await daemon.cost()).output).toContain("accounting         off")
      await until(async () => (await daemon.saved(client.sessionId)) !== undefined, "off persist")
      expect((await daemon.saved(client.sessionId))?.usageAccounting).toBeUndefined()
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test("restored estimates remain marked through HTTP, WS and a priced turn", async () => {
    const original = await persistedTargetFromPriorDaemon()
    const daemon = await bootUsageDaemon(new ScriptedUsageLlm())
    try {
      await saveSessionById(
        original.meta,
        { ...original, usageAccounting: historicalEstimate(original.meta.id) },
        daemon.sessionRoot,
      )
      const client = await daemon.connect(original.meta.id)
      expect((await daemon.cost()).output).toContain("estimated portion  $3.0000")
      expect(await renderSnapshotHeader(client.snapshot())).toContain("estimated: $3.00")
      expect(on(await client.run("KNOWN-AFTER-HISTORICAL-ESTIMATE"))).toMatchObject({
        calls: 2,
        totalUsd: 6,
        estimatedUsd: 3,
        unpricedCalls: 1,
      })
      await daemon.waitSaved(original.meta.id, 2)
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test("hostile model identity stays exact on disk but bounded on display wires", async () => {
    const daemon = await bootUsageDaemon(new ScriptedUsageLlm())
    try {
      const client = await daemon.connect()
      const wire = on(await client.run("HOSTILE-COST-MODEL"))
      expect(wire.modelSlug).toBe(`bad[31m${"x".repeat(57)}`)
      expect(wire.modelSlug?.length).toBe(64)
      const saved = await daemon.waitSaved(client.sessionId, 1)
      const fresh = createUsageAccounting()
      expect(fresh.hydrate(saved.usageAccounting ?? "")).toBe(true)
      expect(fresh.recent(1)[0]?.usage.model).toBe(HOSTILE_MODEL)
      expect(await renderSnapshotHeader((await daemon.connect()).snapshot())).toContain(
        `model: ${wire.modelSlug}`,
      )
      expect(daemon.externalNetworkAttempts()).toBe(0)
    } finally {
      await daemon.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test("corrupt attach is partial before spend and survives another daemon", async () => {
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
          "corrupt target marker",
        )
        const header = await renderSnapshotHeader(client.snapshot())
        expect(header).toContain("prior totals lost")
        expect(header).not.toContain("$0")
        expect(on(await client.run("RECOVERED-PARTIAL-FIRST"))).toMatchObject({
          calls: 1,
          totalUsd: 3,
          continuityLost: true,
        })
        return await daemon.waitSaved(original.meta.id, 1, "{ corrupt")
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
        "partial marker after restart",
      )
      expect(await renderSnapshotHeader(client.snapshot())).toContain("prior totals lost")
      expect(on(await client.run("RECOVERED-PARTIAL-NEXT"))).toMatchObject({
        calls: 2,
        totalUsd: 6,
        continuityLost: true,
      })
      await restarted.waitSaved(recovered.meta.id, 2)
      expect(restarted.externalNetworkAttempts()).toBe(0)
    } finally {
      await restarted.cleanup()
    }
  }, TEST_TIMEOUT_MS)
})
