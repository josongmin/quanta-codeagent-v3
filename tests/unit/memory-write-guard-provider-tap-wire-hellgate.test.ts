/**
 * jul-03 B3 structural wiring hellgate — the PROVIDER rate-limit tap reaches the
 * memory write-guard THROUGH the real `buildToolingCore` assembler, SEPARATE from
 * the local cost fraction.
 *
 * THE SEAM THIS PINS (adversarial): the guard must consult the REAL provider
 * `x-ratelimit-remaining` signal, not just the local cost meter (which returns
 * 100 with no dial). This test drives the assembler with a local cost closure
 * that reads 100 (plenty) AND a separate provider closure that reads a low value,
 * proving the provider arm blocks even when the local arm would allow.
 *
 * MUTATION-CHECKED — dropping EITHER seam turns this RED:
 *   - drop the `providerRateLimitRemainingPercent` threading in `tooling.ts`
 *     `buildMemoryExtras` ⇒ the guard never sees the provider closure ⇒ the write
 *     PROCEEDS (local cost=100) ⇒ the "BLOCKED by provider" assertion fails.
 *   - drop the provider arm in `memory-tools.ts` `writeBlockReason` ⇒ same.
 *   - collapse the two signals into one (read cost only) ⇒ the divergence test
 *     (cost=100, provider=5) fails.
 *
 * DETERMINISTIC — a live `BudgetMeter` drives BOTH signals: a `maxTotalTokens`
 * dial for the local cost fraction and `observeProviderRateLimitRemainingPercent`
 * for the provider window. No network, no clock, no `process.env`.
 */

import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent"
import {
  applyMemoryPatch,
  type MemoryEntry,
  type MemoryPatch,
  type MemoryQuery,
  type PersistentStorePort,
} from "@/memory"
import { StructuredLogger } from "@/observability"
import { buildToolingCore } from "@/runner/assemble"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }

const run = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

class TinyStore implements PersistentStorePort {
  private readonly map = new Map<string, MemoryEntry>()
  save(e: MemoryEntry): Promise<void> {
    this.map.set(e.id, e)
    return Promise.resolve()
  }
  update(id: string, patch: MemoryPatch): Promise<void> {
    const cur = this.map.get(id)
    if (cur) this.map.set(id, applyMemoryPatch(cur, patch, Date.now()))
    return Promise.resolve()
  }
  delete(id: string): Promise<void> {
    this.map.delete(id)
    return Promise.resolve()
  }
  get(id: string): Promise<MemoryEntry | undefined> {
    return Promise.resolve(this.map.get(id))
  }
  all(): Promise<MemoryEntry[]> {
    return Promise.resolve([...this.map.values()])
  }
  recall(_q: MemoryQuery): Promise<MemoryEntry[]> {
    return Promise.resolve([...this.map.values()])
  }
}

const slog = new StructuredLogger()

const writeToolFor = (args: {
  readonly writeGuardMinRemainingPercent?: number
  readonly budgetRemainingPercent?: () => number
  readonly providerRateLimitRemainingPercent?: () => number | undefined
  readonly slog?: StructuredLogger
}): { tool: Tool; store: TinyStore } => {
  const store = new TinyStore()
  const tooling = buildToolingCore({
    store,
    embedder: undefined,
    sessionId: "s",
    memoryConfig:
      args.writeGuardMinRemainingPercent !== undefined
        ? { writeGuardMinRemainingPercent: args.writeGuardMinRemainingPercent }
        : {},
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    mcpTools: [],
    lspTools: [],
    lspNavTools: [],
    gitToolList: [],
    slog: args.slog ?? slog,
    ...(args.budgetRemainingPercent !== undefined
      ? { budgetRemainingPercent: args.budgetRemainingPercent }
      : {}),
    ...(args.providerRateLimitRemainingPercent !== undefined
      ? { providerRateLimitRemainingPercent: args.providerRateLimitRemainingPercent }
      : {}),
  })
  const tool = tooling.registry.all().find((t) => t.name === "memory_write")
  if (!tool) throw new Error("memory_write not registered")
  return { tool, store }
}

describe("memory write-guard — provider rate-limit tap threaded through buildToolingCore", () => {
  test("provider window BELOW threshold BLOCKS even though local cost reads 100 (no dial)", async () => {
    // Live meter: NO cost dial ⇒ remainingPercent()===100 (the fake signal).
    // Provider window observed at 5% ⇒ the REAL signal must refuse.
    const meter = new BudgetMeter()
    meter.observeProviderRateLimitRemainingPercent(5)
    const { tool, store } = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
      providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(),
    })
    // Pre-condition: the local arm alone would NOT block (proves separation).
    expect(meter.remainingPercent()).toBe(100)
    const ev = await run(tool, { text: "remember" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toContain("provider rate-limit")
    }
    expect(await store.all()).toHaveLength(0)
  })

  test("provider window ABOVE threshold ⇒ write proceeds", async () => {
    const meter = new BudgetMeter()
    meter.observeProviderRateLimitRemainingPercent(90)
    const { tool, store } = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
      providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(),
    })
    const ev = await run(tool, { text: "remember" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  test("provider tap present but NEVER observed (undefined) ⇒ provider arm fails OPEN", async () => {
    const meter = new BudgetMeter() // no provider observation ⇒ undefined
    const { tool, store } = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
      providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(),
    })
    const ev = await run(tool, { text: "remember" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  test("NO threshold ⇒ no guard regardless of provider closure (byte-identical)", async () => {
    const meter = new BudgetMeter()
    meter.observeProviderRateLimitRemainingPercent(0) // would block IF guarded
    const { tool, store } = writeToolFor({
      budgetRemainingPercent: () => meter.remainingPercent(),
      providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(),
    })
    const ev = await run(tool, { text: "remember" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  // jul-03 B3 AUDIT — the arm-state telemetry (`onArm`, commit item #4) was
  // DEFINED but never wired in PRODUCTION: only tests passed `onArm`, so the
  // guard's fail-open was silently inert in a real run (contradicting dispatch
  // #3 "fail-open is OBSERVABLE"). The assembler now wires it to the SAME
  // StructuredLogger it uses for config-liveness. This pins that seam: dropping
  // the `onArm` wiring in `buildMemoryExtras` turns these RED.
  test("arm-state telemetry reaches the assembler's StructuredLogger (OBSERVABLE fail-open)", async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = []
    const spyLog = new StructuredLogger()
    // Capture the exact (event, fields) the guard emits through the real logger.
    ;(spyLog as unknown as { debug: unknown }).debug = (
      event: string,
      fields?: Record<string, unknown>,
    ): void => {
      events.push({ event, ...(fields !== undefined ? { fields } : {}) })
    }
    const meter = new BudgetMeter()
    meter.observeProviderRateLimitRemainingPercent(5) // provider window low ⇒ blocks
    const { tool, store } = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(), // 100 (cost arm passes)
      providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(),
      slog: spyLog,
    })
    await run(tool, { text: "remember" })
    const armEvents = events.filter((e) => e.event === "memory.write_guard.arm")
    // BOTH arms evaluated ⇒ both emit; the provider arm is armed+blocked.
    expect(armEvents.length).toBe(2)
    expect(armEvents).toContainEqual(
      expect.objectContaining({
        event: "memory.write_guard.arm",
        fields: expect.objectContaining({ source: "provider", armed: true, blocked: true }),
      }),
    )
    expect(await store.all()).toHaveLength(0)
  })

  test("provider arm UNARMED (fail-open) is still OBSERVABLE in telemetry, not silent", async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = []
    const spyLog = new StructuredLogger()
    ;(spyLog as unknown as { debug: unknown }).debug = (
      event: string,
      fields?: Record<string, unknown>,
    ): void => {
      events.push({ event, ...(fields !== undefined ? { fields } : {}) })
    }
    const meter = new BudgetMeter() // provider never observed ⇒ undefined ⇒ fails open
    const { tool } = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
      providerRateLimitRemainingPercent: () => meter.providerRateLimitRemainingPercent(),
      slog: spyLog,
    })
    await run(tool, { text: "remember" })
    // The fail-open (unarmed) provider evaluation is RECORDED — proving it is not
    // a silent inert config: an operator can SEE the arm was unarmed.
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "memory.write_guard.arm",
        fields: expect.objectContaining({ source: "provider", armed: false, blocked: false }),
      }),
    )
  })
})
