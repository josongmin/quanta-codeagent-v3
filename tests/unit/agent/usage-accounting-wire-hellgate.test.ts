/**
 * MR-03 hellgate — wiring the accountant into the loop.
 *
 * Three things have to hold for the authority to be worth anything:
 *
 *   1. Unwired, the loop is byte-identical. The slot is default-OFF, so an
 *      absent accountant must change nothing a legacy caller can observe.
 *   2. Provenance comes from LINEAGE, not from whoever happens to be emitting.
 *      `depth` is set at spawn and persisted, so it survives resume; deriving
 *      "am I a subagent" from anything more incidental would misattribute
 *      spend after a session is restored.
 *   3. Parent and child share ONE accountant and still get distinct call ids.
 *      Sharing is the entire fix; colliding ids would silently drop the
 *      child's spend as a duplicate, reintroducing the bug through the back
 *      door.
 */
import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent/budget/meter"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { isRootAgent } from "@/agent/spawn-depth"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { createUsageAccounting } from "@/observability/usage-accounting"
import type { AgentEvent } from "@/stream/types"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const usage = (inputTokens: number): UsageEv =>
  ({ type: "usage", model: "claude-sonnet-4-6", inputTokens, outputTokens: 0 }) as UsageEv

const makeConfig = (over: Partial<AgentConfig> = {}) => {
  const events: AgentEvent[] = []
  const config = {
    llm: { stream: async function* () {} },
    registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
    stream: { emit: (e: AgentEvent) => void events.push(e) },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "sess-1",
    ...over,
  } as unknown as AgentConfig
  return { config, events }
}

const emit = (config: AgentConfig, ev: UsageEv) =>
  emitUsage(config, ev, undefined, undefined, undefined)

/** The emitted events are `AgentEvent`s — that union is where the provenance
 *  fields live, distinct from the adapter-facing `StreamEvent` usage shape. */
type EmittedUsage = Extract<AgentEvent, { type: "usage" }>

const usageEvents = (events: readonly AgentEvent[]) =>
  events.filter((e) => e.type === "usage") as ReadonlyArray<EmittedUsage>

describe("default-OFF: no accountant, no behaviour change", () => {
  test("emitting with no accountant still emits exactly one usage event", () => {
    const { config, events } = makeConfig()
    expect(() => emit(config, usage(100))).not.toThrow()
    expect(usageEvents(events)).toHaveLength(1)
  })

  test("the child of an unwired parent stays unwired", () => {
    const { config } = makeConfig()
    const child = buildChildConfig(config, { prompt: "x" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)
    expect(child.usageAccounting).toBeUndefined()
  })
})

describe("provenance is derived from lineage", () => {
  test("a config with no depth is the root", () => {
    const { config, events } = makeConfig({ usageAccounting: createUsageAccounting() })
    emit(config, usage(100))
    expect(usageEvents(events)[0]?.agentKind).toBe("root")
    expect(usageEvents(events)[0]?.agentId).toBe("root")
  })

  test("a persisted depth makes the config a subagent even without a spawn", () => {
    // The resume case: a restored child config is not built by
    // `buildChildConfig` in this process, it is rehydrated. Depth is what
    // survives, so depth is what must decide.
    const accounting = createUsageAccounting()
    const { config } = makeConfig({
      usageAccounting: accounting,
      depth: 2,
      mailboxAgentId: "restored-child",
      mailboxParentId: "root",
    } as Partial<AgentConfig>)
    emit(config, usage(100))

    const snap = accounting.snapshot()
    expect(snap.byKind.subagent.freshInputTokens).toBe(100)
    expect(snap.byKind.root.freshInputTokens).toBe(0)
    expect(snap.byAgent.get("restored-child")?.calls).toBe(1)
    expect(accounting.recent()[0]?.provenance.depth).toBe(2)
    expect(accounting.recent()[0]?.provenance.parentAgentId).toBe("root")
  })
})

describe("one rule decides root vs subagent, and both call sites use it", () => {
  test("isRootAgent answers from persisted depth", () => {
    expect(isRootAgent({})).toBe(true) // no depth ⇒ genuine root
    expect(isRootAgent({ depth: 0 })).toBe(true)
    expect(isRootAgent({ depth: 1 })).toBe(false)
    expect(isRootAgent({ depth: 3 })).toBe(false) // a resumed deep child
  })

  test("usage provenance agrees with the predicate", () => {
    const accounting = createUsageAccounting()
    for (const depth of [undefined, 0, 1, 2]) {
      const acct = createUsageAccounting()
      const { config } = makeConfig({
        usageAccounting: acct,
        ...(depth !== undefined ? { depth } : {}),
      } as Partial<AgentConfig>)
      emit(config, usage(10))
      const kind = isRootAgent({ ...(depth !== undefined ? { depth } : {}) }) ? "root" : "subagent"
      expect(acct.snapshot().byKind[kind].calls).toBe(1)
    }
    expect(accounting.snapshot().calls).toBe(0) // the shared fixture stayed untouched
  })

  test("only a ROOT turn advances the run's turn accounting", () => {
    // The meter is shared with subagents so their SPEND counts against the
    // run's ceiling. Turn boundaries are not shared: a child turn that ticked
    // here would reset the parent's per-turn cost guard mid-turn and inflate
    // `turns` against the root's maxTurns. This pins the asymmetry at the
    // predicate both sites read.
    const meter = new BudgetMeter({})
    const tickIfRoot = (cfg: Pick<AgentConfig, "depth">) => {
      if (isRootAgent(cfg)) meter.tick("turn")
    }
    tickIfRoot({}) // root turn
    tickIfRoot({ depth: 1 }) // subagent turn
    tickIfRoot({ depth: 2 }) // deeper subagent turn
    expect(meter.snapshot().turns).toBe(1)
  })
})

describe("parent and child share one accountant without colliding", () => {
  const wired = () => {
    const accounting = createUsageAccounting()
    const { config, events } = makeConfig({ usageAccounting: accounting })
    const child = buildChildConfig(config, { prompt: "x" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)
    return { accounting, config, child, events }
  }

  test("both spends land in one set of counters, split by kind", () => {
    const { accounting, config, child } = wired()
    emit(config, usage(100))
    emit(child, usage(500))

    const snap = accounting.snapshot()
    expect(snap.calls).toBe(2)
    expect(snap.freshInputTokens).toBe(600)
    expect(snap.byKind.root.freshInputTokens).toBe(100)
    expect(snap.byKind.subagent.freshInputTokens).toBe(500)
  })

  test("call ids are distinct across the shared accountant", () => {
    // If parent and child restarted the sequence independently, the child's
    // first call would collide with the parent's and be dropped as a
    // duplicate — the original bug, wearing the fix's clothes.
    const { accounting, config, child } = wired()
    // Two calls from the SAME agent is the case that actually collides — the
    // agent id alone already separates parent from child, so a per-config
    // sequence reset hides behind that unless one agent calls twice.
    emit(config, usage(100))
    emit(config, usage(100))
    emit(child, usage(500))
    emit(child, usage(500))

    const ids = accounting.recent().map((r) => r.callId)
    expect(new Set(ids).size).toBe(4)
    expect(accounting.snapshot().calls).toBe(4) // nothing dropped as a duplicate
    expect(accounting.snapshot().freshInputTokens).toBe(1200)
  })

  test("cache-write reaches the accountant as its own bucket", () => {
    // The adapter reports cache CREATION; the canonical name is cache-write,
    // and it is the bucket the total-cost entry point cannot express at all.
    const { accounting, config } = wired()
    emit(config, { ...usage(0), cacheCreationTokens: 100_000 } as UsageEv)
    expect(accounting.snapshot().cacheWriteTokens).toBe(100_000)
    expect(accounting.snapshot().totalUsd).toBeCloseTo(0.375, 9)
  })
})
