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
import type { MemoryEntry, MemoryQuery, PersistentStorePort } from "@/memory"
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
  update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const cur = this.map.get(id)
    if (cur) this.map.set(id, { ...cur, ...patch })
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
    slog,
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
})
