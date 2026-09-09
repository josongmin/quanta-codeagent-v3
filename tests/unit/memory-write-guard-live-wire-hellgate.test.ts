/**
 * jun-02 hellgate — memory write-guard LIVE on the CLI tooling root.
 *
 * THE GAP THIS SEALS (adversarial review): `QUANTA_MEMORY_WRITE_GUARD_PCT`
 * resolves into `config.memory.writeGuardMinRemainingPercent`, but the guard is
 * built in `buildToolingCore`'s `buildMemoryExtras` ONLY when the surface ALSO
 * supplies a live `budgetRemainingPercent` closure. The CLI's `buildTooling`
 * call OMITTED that closure, so the guard was inert (fail-open) — every write
 * proceeded regardless of the threshold.
 *
 * The fix threads `() => meter.remainingPercent()` from a session `BudgetMeter`
 * (constructed in the bootstrap when the guard knob is set) into
 * `buildToolingCore`. This test proves the env→behavior path THROUGH the REAL
 * tooling assembler with a LIVE meter:
 *   - guard threshold set + live meter below threshold ⇒ `memory_write` BLOCKED.
 *   - guard threshold set + live meter at/above threshold ⇒ write PROCEEDS.
 *   - guard threshold set but NO closure (the prior DOA state) ⇒ write PROCEEDS
 *     (proving the closure threading is exactly what activates the guard).
 *   - no threshold ⇒ no guard regardless of the closure (byte-identical).
 *
 * DETERMINISTIC — the meter's remaining% is driven by a `maxTotalTokens` dial +
 * explicit `tick`s. No network, no clock dependence, no `process.env`.
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

/** Minimal in-memory store (the self-edit tools only need save/recall here). */
class TinyStore implements PersistentStorePort {
  private readonly map = new Map<string, MemoryEntry>()
  save(entry: MemoryEntry): Promise<void> {
    this.map.set(entry.id, entry)
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

const SESSION = "test-session"
const slog = new StructuredLogger()

/** Build the memory_write tool via the REAL CLI tooling assembler. */
const writeToolFor = (args: {
  readonly writeGuardMinRemainingPercent?: number
  readonly budgetRemainingPercent?: () => number
}): Tool => {
  const tooling = buildToolingCore({
    store: new TinyStore(),
    embedder: undefined,
    sessionId: SESSION,
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
  })
  const tool = tooling.registry.all().find((t) => t.name === "memory_write")
  if (!tool) throw new Error("memory_write not registered")
  return tool
}

/** A live BudgetMeter with a token dial, ticked to a chosen consumption so its
 *  `remainingPercent()` is deterministic (binding smallest-remaining dial). */
const meterAtRemaining = (remainingPct: number): BudgetMeter => {
  const maxTotalTokens = 1000
  const meter = new BudgetMeter({ dials: { maxTotalTokens } })
  const spend = Math.round((maxTotalTokens * (100 - remainingPct)) / 100)
  if (spend > 0) meter.tick("input_tokens", spend)
  return meter
}

describe("memory write-guard — live BudgetMeter closure threaded through buildToolingCore", () => {
  test("threshold set + live meter BELOW threshold ⇒ memory_write BLOCKED", async () => {
    const meter = meterAtRemaining(10) // 10% remaining
    const tool = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
    })
    const ev = await run(tool, { text: "remember this" })
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("unreachable")
    expect(ev.result.ok).toBe(false)
    expect(ev.result.output).toContain("skipped")
    expect(ev.result.output).toContain("threshold")
  })

  test("threshold set + live meter ABOVE threshold ⇒ write PROCEEDS", async () => {
    const meter = meterAtRemaining(80) // 80% remaining
    const tool = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
    })
    const ev = await run(tool, { text: "remember this" })
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("unreachable")
    expect(ev.result.ok).toBe(true)
  })

  test("threshold set but NO closure (the prior DOA state) ⇒ write PROCEEDS (inert)", async () => {
    const tool = writeToolFor({ writeGuardMinRemainingPercent: 25 })
    const ev = await run(tool, { text: "remember this" })
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("unreachable")
    // Proves the guard is inert WITHOUT the closure — i.e. the bug. The fix
    // (threading the closure) is what flips this to BLOCKED above.
    expect(ev.result.ok).toBe(true)
  })

  test("no threshold + live closure ⇒ no guard (byte-identical, write proceeds)", async () => {
    const meter = meterAtRemaining(0) // 0% remaining — would block IF guarded
    const tool = writeToolFor({ budgetRemainingPercent: () => meter.remainingPercent() })
    const ev = await run(tool, { text: "remember this" })
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("unreachable")
    expect(ev.result.ok).toBe(true)
  })

  test("boundary is inclusive on allow side (remaining == threshold ⇒ proceeds)", async () => {
    const meter = meterAtRemaining(25)
    const tool = writeToolFor({
      writeGuardMinRemainingPercent: 25,
      budgetRemainingPercent: () => meter.remainingPercent(),
    })
    const ev = await run(tool, { text: "remember this" })
    expect(ev.type).toBe("result")
    if (ev.type !== "result") throw new Error("unreachable")
    expect(ev.result.ok).toBe(true)
  })
})
