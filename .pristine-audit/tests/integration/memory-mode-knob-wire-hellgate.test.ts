import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent/budget/meter"
import { InMemoryStore } from "@/memory"
import { StructuredLogger } from "@/observability"
import { resolveMemoryConfigFromEnv } from "@/runner/assemble/memory-factory"
import { buildToolingCore } from "@/runner/assemble/tooling"
import {
  memoryModeKnob,
  parseMemoryLineCitations,
  parseMemoryThreadMode,
  parseMemoryWriteGuardPct,
  projectMemoryModeValue,
} from "@/runner/knobs/knobs/memory-mode"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

// ADR-0432 — knob + factory + tooling WIRE hellgate. Proves the env-driven
// deps actually reach `memoryTools` through `buildToolingCore`, that the knob
// parse domain rejects garbage, and that the absent-env path is byte-identical.

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }
const slog = new StructuredLogger()

const run = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}
const seeded = () =>
  new InMemoryStore([
    { id: "m1", kind: "fact", text: "alpha\nbeta", tags: [], createdAt: 1, importance: 0.7 },
  ])

describe("ADR-0432 knob parse domain (validated signals, no heuristics)", () => {
  test("threadMode accepts the three closed literals (case/space tolerant)", () => {
    expect(parseMemoryThreadMode("enabled")).toBe("enabled")
    expect(parseMemoryThreadMode(" READ-ONLY ")).toBe("read-only")
    expect(parseMemoryThreadMode("Disabled")).toBe("disabled")
  })
  test("threadMode rejects garbage ⇒ undefined", () => {
    for (const raw of [undefined, "", "on", "off", "ro", "readonly", "1", "enable"]) {
      expect(parseMemoryThreadMode(raw)).toBeUndefined()
    }
  })
  test("write-guard-pct accepts integers in [0,100], rejects everything else", () => {
    expect(parseMemoryWriteGuardPct("0")).toBe(0)
    expect(parseMemoryWriteGuardPct("100")).toBe(100)
    expect(parseMemoryWriteGuardPct(" 25 ")).toBe(25)
    for (const raw of [undefined, "", "-1", "101", "5.0", "5e1", "0x5", "abc", "5 5", "NaN", " "]) {
      expect(parseMemoryWriteGuardPct(raw)).toBeUndefined()
    }
  })
  test("line-citations true iff exactly '1'", () => {
    expect(parseMemoryLineCitations("1")).toBe(true)
    for (const raw of [undefined, "", "0", "true", "on", "yes", "2"]) {
      expect(parseMemoryLineCitations(raw)).toBeUndefined()
    }
  })
  test("projectMemoryModeValue: all-absent ⇒ undefined; any axis ⇒ object", () => {
    expect(
      projectMemoryModeValue({ mode: undefined, guardPct: undefined, lineCitations: undefined }),
    ).toBeUndefined()
    expect(
      projectMemoryModeValue({ mode: "garbage", guardPct: "x", lineCitations: "0" }),
    ).toBeUndefined()
    expect(
      projectMemoryModeValue({ mode: "read-only", guardPct: "30", lineCitations: "1" }),
    ).toEqual({ threadMode: "read-only", lineCitations: true, writeGuardMinRemainingPercent: 30 })
  })
  test("knob keyed on QUANTA_MEMORY_MODE; cli + agent surfaces, NOT bench", () => {
    expect(memoryModeKnob.envKey).toBe("QUANTA_MEMORY_MODE")
    expect(memoryModeKnob.surfaces).toContain("cli")
    expect(memoryModeKnob.surfaces).toContain("agent-interactive")
    // memory mode is a runtime knob, not a SWE-bench sweep axis.
    expect(memoryModeKnob.surfaces).not.toContain("bench")
  })
})

describe("ADR-0432 resolveMemoryConfigFromEnv (env → MemoryConfigBlock)", () => {
  test("disabled mode env populates threadMode", () => {
    const cfg = resolveMemoryConfigFromEnv({ QUANTA_MEMORY_MODE: "disabled" }, seeded())
    expect(cfg?.threadMode).toBe("disabled")
  })
  test("all three envs populate all three fields", () => {
    const cfg = resolveMemoryConfigFromEnv(
      {
        QUANTA_MEMORY_MODE: "read-only",
        QUANTA_MEMORY_LINE_CITATIONS: "1",
        QUANTA_MEMORY_WRITE_GUARD_PCT: "40",
      },
      seeded(),
    )
    expect(cfg?.threadMode).toBe("read-only")
    expect(cfg?.lineCitations).toBe(true)
    expect(cfg?.writeGuardMinRemainingPercent).toBe(40)
  })
  test("absent envs ⇒ fields stay absent (byte-identical block)", () => {
    const withStore = resolveMemoryConfigFromEnv({}, seeded())
    expect(withStore?.threadMode).toBeUndefined()
    expect(withStore?.lineCitations).toBeUndefined()
    expect(withStore?.writeGuardMinRemainingPercent).toBeUndefined()
  })
  test("invalid envs are dropped (no field set)", () => {
    const cfg = resolveMemoryConfigFromEnv(
      {
        QUANTA_MEMORY_MODE: "bogus",
        QUANTA_MEMORY_LINE_CITATIONS: "0",
        QUANTA_MEMORY_WRITE_GUARD_PCT: "999",
      },
      seeded(),
    )
    expect(cfg?.threadMode).toBeUndefined()
    expect(cfg?.lineCitations).toBeUndefined()
    expect(cfg?.writeGuardMinRemainingPercent).toBeUndefined()
  })
})

const baseToolingInput = (store: InMemoryStore, memoryConfig: ReturnType<typeof seededCfg>) => ({
  store,
  embedder: undefined,
  sessionId: "s",
  memoryConfig,
  subagentConfig: undefined,
  skillsConfig: undefined,
  compactionBreakerConfig: undefined,
  verifyGuardConfig: undefined,
  mcpTools: [],
  lspTools: [],
  lspNavTools: [],
  gitToolList: [],
  slog,
})
const seededCfg = (env: NodeJS.ProcessEnv, store: InMemoryStore) =>
  resolveMemoryConfigFromEnv(env, store)

describe("ADR-0432 buildToolingCore threads deps to a REAL tool dispatch", () => {
  test("QUANTA_MEMORY_MODE=disabled ⇒ real memory_search performs NO recall", async () => {
    const store = seeded()
    const cfg = seededCfg({ QUANTA_MEMORY_MODE: "disabled" }, store)
    const tooling = buildToolingCore(baseToolingInput(store, cfg))
    const search = tooling.registry.get("memory_search")
    expect(search).toBeDefined()
    if (!search) return
    const ev = await run(search, { query: "alpha" })
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      // disabled ⇒ short-circuit message, NOT the recalled entry.
      expect(ev.result.output).not.toContain("#m1")
    }
  })

  test("QUANTA_MEMORY_MODE=disabled ⇒ real memory_write is blocked, store untouched", async () => {
    const store = new InMemoryStore()
    const cfg = seededCfg({ QUANTA_MEMORY_MODE: "disabled" }, store)
    const tooling = buildToolingCore(baseToolingInput(store, cfg))
    const write = tooling.registry.get("memory_write")
    if (!write) throw new Error("no memory_write")
    const ev = await run(write, { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(await store.all()).toHaveLength(0)
  })

  test("line-citations env ⇒ real memory_search output carries the matched sub-span", async () => {
    const store = seeded()
    const cfg = seededCfg({ QUANTA_MEMORY_LINE_CITATIONS: "1" }, store)
    const tooling = buildToolingCore(baseToolingInput(store, cfg))
    const search = tooling.registry.get("memory_search")
    if (!search) throw new Error("no memory_search")
    // Record is "alpha\nbeta"; "alpha" matches on line 1 ⇒ REAL sub-span [L1-1],
    // NOT the degenerate whole-record [L1-2] (jul-03 B3).
    const ev = await run(search, { query: "alpha" })
    if (ev.type === "result") {
      expect(ev.result.output).toContain("#m1")
      expect(ev.result.output).toContain("[L1-1]")
      expect(ev.result.output).not.toContain("[L1-2]")
    }
    // "beta" matches on line 2 ⇒ [L2-2] (proves the offset is really carried).
    const ev2 = await run(search, { query: "beta" })
    if (ev2.type === "result") expect(ev2.result.output).toContain("[L2-2]")
  })

  test("write-guard env + live meter closure ⇒ real write blocked when budget low", async () => {
    const store = new InMemoryStore()
    const cfg = seededCfg({ QUANTA_MEMORY_WRITE_GUARD_PCT: "50" }, store)
    // Live BudgetMeter (ADR-0138): cap 100 input tokens, observe 90 ⇒ 10% remaining.
    const meter = new BudgetMeter({ dials: { maxInputTokens: 100 } })
    meter.tick("input_tokens", 90)
    const tooling = buildToolingCore({
      ...baseToolingInput(store, cfg),
      budgetRemainingPercent: () => meter.remainingPercent(),
    })
    const write = tooling.registry.get("memory_write")
    if (!write) throw new Error("no memory_write")
    const ev = await run(write, { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(await store.all()).toHaveLength(0)
  })

  test("write-guard env but NO meter closure ⇒ guard inert (fail-open, write proceeds)", async () => {
    const store = new InMemoryStore()
    const cfg = seededCfg({ QUANTA_MEMORY_WRITE_GUARD_PCT: "50" }, store)
    const tooling = buildToolingCore(baseToolingInput(store, cfg)) // no budgetRemainingPercent
    const write = tooling.registry.get("memory_write")
    if (!write) throw new Error("no memory_write")
    const ev = await run(write, { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  test("absent envs ⇒ tools byte-identical to legacy (recall works, no citation span)", async () => {
    const store = seeded()
    const cfg = seededCfg({}, store)
    const tooling = buildToolingCore(baseToolingInput(store, cfg))
    const search = tooling.registry.get("memory_search")
    if (!search) throw new Error("no memory_search")
    const ev = await run(search, { query: "alpha" })
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toContain("#m1")
      expect(ev.result.output).not.toContain("[L")
    }
  })
})

describe("ADR-0432 BudgetMeter.remainingPercent (pure, propositional)", () => {
  test("no consumable dial ⇒ 100 (unbounded)", () => {
    expect(new BudgetMeter().remainingPercent()).toBe(100)
  })
  test("token dial: 30/100 consumed ⇒ 70%", () => {
    const m = new BudgetMeter({ dials: { maxInputTokens: 100 } })
    m.tick("input_tokens", 30)
    expect(m.remainingPercent()).toBeCloseTo(70, 6)
  })
  test("binding (smallest-remaining) dial wins across dims", () => {
    const m = new BudgetMeter({ dials: { maxInputTokens: 100, maxOutputTokens: 100 } })
    m.tick("input_tokens", 10) // 90% remaining
    m.tick("output_tokens", 80) // 20% remaining ⇒ binding
    expect(m.remainingPercent()).toBeCloseTo(20, 6)
  })
  test("over-consumed dial clamps to 0 (never negative)", () => {
    const m = new BudgetMeter({ dials: { maxInputTokens: 100 } })
    m.tick("input_tokens", 250)
    expect(m.remainingPercent()).toBe(0)
  })
  test("degenerate dial (0) is skipped, not divide-by-zero", () => {
    const m = new BudgetMeter({ dials: { maxInputTokens: 0, maxOutputTokens: 100 } })
    m.tick("output_tokens", 25)
    expect(m.remainingPercent()).toBeCloseTo(75, 6)
  })
})
