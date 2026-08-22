/**
 * ADR-0402 hellgate — Objective LLM tools (`objective_set` / `objective_update` /
 * `objective_get`) wired to the ADR-0394 `ObjectivePort`.
 *
 * Three dimensions:
 *
 *   A. WIRE (structural) — mirrors `delegate-tool-hellgate` shape:
 *      (1) tier1 barrel re-exports `buildObjectiveBlock`.
 *      (2) `AgentConfig.objective` slot accepts an `ObjectivePort`.
 *      (3) `FeaturesConfig` Pick union includes `"objective"`.
 *      (4) slot ABSENT ⇒ none of the 3 tools land in extraTools
 *          (default-OFF byte-identical).
 *      (5) slot WIRED ⇒ all 3 tools land in extraTools.
 *      (6) the wired tools route through the SAME port instance.
 *
 *   B. SCHEMA / VALIDATION — each `op` discriminated-union variant round-trips,
 *      malformed input (missing thread_id / unknown op / bad enum) yields a
 *      typed `ok:false` (NEVER throws past the loop).
 *
 *   C. NO-THROW / OUTPUT — a throwing fake port must surface as `ok:false`,
 *      `objective_get` returns "no objective" string for unknown thread, and
 *      the rendered text contains goal + status + blockers-count + nextActions.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { createObjectiveStore, type ObjectivePort } from "@/objective"
import { buildObjectiveBlock } from "@/agent/tier1"
import type { AgentConfig, FeaturesConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, type Tool, type ToolContext, ToolRegistry } from "@/tool"
import { objectiveTools } from "@/tool/objective"

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    ...over,
  }) as AgentConfig

// RFC-03 C1: the objective tools bind their thread identity from the SESSION
// (`ctx.ownerId`, stamped from AgentConfig.sessionId), NEVER from the model's
// `thread_id` argument. Tests therefore supply the bound owner id here; the
// default matches the "t" thread most cases seed/read.
const ctx = (ownerId = "t", signal: AbortSignal = new AbortController().signal): ToolContext => ({
  cwd: "/tmp",
  signal,
  ownerId,
})

/** Drive a tool to its terminal `result` event and return `{ok, output}`. */
const drain = async (
  tool: Tool,
  input: unknown,
  c: ToolContext = ctx(),
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  if (last === undefined) throw new Error("tool yielded no terminal result")
  return last
}

const findTool = (tools: readonly Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

// ─────────────────────────────────────────────────────────────────────────────
// A. WIRE
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — wire hellgate (ADR-0402)", () => {
  test("(1) tier1 barrel re-exports buildObjectiveBlock", () => {
    expect(typeof buildObjectiveBlock).toBe("function")
  })

  test("(2) AgentConfig.objective slot accepts an ObjectivePort", () => {
    const port = createObjectiveStore()
    const cfg = baseCfg({ objective: port })
    expect(cfg.objective).toBe(port)
  })

  test("(3) FeaturesConfig Pick union includes 'objective'", () => {
    const port = createObjectiveStore()
    const fc: FeaturesConfig = baseCfg({ objective: port })
    expect(fc.objective).toBe(port)
  })

  test("(4) slot absent ⇒ none of 3 tools land (default-OFF byte-identical)", async () => {
    const features = await buildSessionFeatures(baseCfg())
    const names = features.extraTools.map((t) => t.name)
    expect(names).not.toContain("objective_set")
    expect(names).not.toContain("objective_update")
    expect(names).not.toContain("objective_get")
  })

  test("(5) slot wired ⇒ all 3 tools land in extraTools", async () => {
    const features = await buildSessionFeatures(baseCfg({ objective: createObjectiveStore() }))
    const names = features.extraTools.map((t) => t.name)
    expect(names).toContain("objective_set")
    expect(names).toContain("objective_update")
    expect(names).toContain("objective_get")
  })

  test("(6) builder binds to the SAME port (set ⇒ get round-trip)", async () => {
    const port = createObjectiveStore()
    const tools = buildObjectiveBlock(baseCfg({ objective: port }))
    const setTool = findTool(tools, "objective_set")
    const getTool = findTool(tools, "objective_get")
    const setOut = await drain(setTool, { thread_id: "t1", goal: "ship it" }, ctx("t1"))
    expect(setOut.ok).toBe(true)
    const getOut = await drain(getTool, { thread_id: "t1" }, ctx("t1"))
    expect(getOut.ok).toBe(true)
    expect(getOut.output).toContain("ship it")
  })

  test("(0) buildObjectiveBlock returns [] when port absent", () => {
    const tools = buildObjectiveBlock(baseCfg())
    expect(tools).toEqual([])
  })

  test("(0) buildObjectiveBlock returns 3 tools when port present", () => {
    const tools = buildObjectiveBlock(baseCfg({ objective: createObjectiveStore() }))
    expect(tools.map((t) => t.name).sort()).toEqual([
      "objective_get",
      "objective_set",
      "objective_update",
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. SCHEMA / VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — schema validation hellgate (ADR-0402)", () => {
  test("objective_set requires non-empty goal", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_set"), { thread_id: "t", goal: "" })
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("invalid")
  })

  test("objective_set rejects missing thread_id", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_set"), { goal: "g" })
    expect(out.ok).toBe(false)
  })

  test("objective_update rejects unknown op kind", async () => {
    const port = createObjectiveStore()
    port.set("t", { goal: "g" })
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "wizardry" },
    })
    expect(out.ok).toBe(false)
  })

  test("objective_update rejects bad enum (waiting_on)", async () => {
    const port = createObjectiveStore()
    port.set("t", { goal: "g" })
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "addBlocker", reason: "x", waiting_on: "moon" },
    })
    expect(out.ok).toBe(false)
  })

  test("objective_update rejects bad status enum", async () => {
    const port = createObjectiveStore()
    port.set("t", { goal: "g" })
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "status", status: "halfway" },
    })
    expect(out.ok).toBe(false)
  })

  test("objective_get rejects missing thread_id", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_get"), {})
    expect(out.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. OP VARIANT ROUND-TRIP
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — op variant round-trip (ADR-0402)", () => {
  const seed = async (): Promise<{ port: ObjectivePort; tools: readonly Tool[] }> => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    await drain(findTool(tools, "objective_set"), {
      thread_id: "t",
      goal: "build feature",
      success_criteria: ["tests pass", "tsc 0"],
    })
    return { port, tools }
  }

  test("status op routes to updateStatus", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "status", status: "completed" },
    })
    expect(out.ok).toBe(true)
    expect(port.get("t")?.status).toBe("completed")
  })

  test("addBlocker op routes to addBlocker (status derives to 'blocked')", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "addBlocker", reason: "needs key", waiting_on: "user" },
    })
    expect(out.ok).toBe(true)
    const o = port.get("t")
    expect(o?.status).toBe("blocked")
    expect(o?.blockers.length).toBe(1)
  })

  test("clearBlocker op routes to clearBlocker", async () => {
    const { port, tools } = await seed()
    port.addBlocker("t", { reason: "x", waitingOn: "tool" })
    const blockerId = port.get("t")?.blockers[0]?.id ?? ""
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "clearBlocker", blocker_id: blockerId },
    })
    expect(out.ok).toBe(true)
    expect(port.get("t")?.blockers.length).toBe(0)
  })

  test("nextActions op routes to setNextActions", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "nextActions", actions: ["draft test", "implement"] },
    })
    expect(out.ok).toBe(true)
    expect(port.get("t")?.nextActions).toEqual(["draft test", "implement"])
  })

  test("markCriterion op routes to markCriterion", async () => {
    const { port, tools } = await seed()
    const cid = port.get("t")?.successCriteria[0]?.id ?? ""
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "markCriterion", criterion_id: cid, met: true },
    })
    expect(out.ok).toBe(true)
    expect(port.get("t")?.successCriteria[0]?.met).toBe(true)
  })

  test("recordUsage op routes to recordUsage", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "recordUsage", tokens: 100, turns: 2 },
    })
    expect(out.ok).toBe(true)
    const o = port.get("t")
    expect(o?.budget.tokensUsed).toBe(100)
    expect(o?.budget.turnsUsed).toBe(2)
  })

  test("recordUsage accepts tokens-only", async () => {
    const { port, tools } = await seed()
    await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "recordUsage", tokens: 50 },
    })
    expect(port.get("t")?.budget.tokensUsed).toBe(50)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. NO-THROW + OUTPUT SHAPE
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — NO-THROW + output shape (ADR-0402)", () => {
  /** A hostile port — every method throws. The tool must NEVER bubble it. */
  const throwingPort = (): ObjectivePort =>
    ({
      set() {
        throw new Error("boom")
      },
      get() {
        throw new Error("boom")
      },
      updateStatus() {
        throw new Error("boom")
      },
      addBlocker() {
        throw new Error("boom")
      },
      clearBlocker() {
        throw new Error("boom")
      },
      setNextActions() {
        throw new Error("boom")
      },
      markCriterion() {
        throw new Error("boom")
      },
      recordUsage() {
        throw new Error("boom")
      },
      list() {
        throw new Error("boom")
      },
      toSnapshot() {
        throw new Error("boom")
      },
      fromSnapshot() {
        throw new Error("boom")
      },
    }) as unknown as ObjectivePort

  test("throwing port.set ⇒ ok:false (never bubbles)", async () => {
    const tools = objectiveTools(throwingPort())
    const out = await drain(findTool(tools, "objective_set"), { thread_id: "t", goal: "g" })
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("error")
  })

  test("throwing port.get ⇒ ok:false (never bubbles)", async () => {
    const tools = objectiveTools(throwingPort())
    const out = await drain(findTool(tools, "objective_get"), { thread_id: "t" })
    expect(out.ok).toBe(false)
  })

  test("throwing port.addBlocker (via update) ⇒ ok:false (never bubbles)", async () => {
    const tools = objectiveTools(throwingPort())
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "addBlocker", reason: "x", waiting_on: "tool" },
    })
    expect(out.ok).toBe(false)
  })

  test("objective_get for unknown thread ⇒ ok:false 'no objective set for thread <id>'", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_get"), { thread_id: "missing" }, ctx("missing"))
    expect(out.ok).toBe(false)
    expect(out.output).toContain("no objective set for thread missing")
  })

  test("objective_set rendered output contains goal + status", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_set"), {
      thread_id: "t",
      goal: "ship feature X",
    })
    expect(out.ok).toBe(true)
    expect(out.output).toContain("ship feature X")
    expect(out.output).toContain("active")
  })

  test("objective_get output contains goal + status + blockers count + nextActions", async () => {
    const port = createObjectiveStore()
    port.set("t", { goal: "the goal" })
    port.addBlocker("t", { reason: "waiting", waitingOn: "user" })
    port.setNextActions("t", ["do A", "do B"])
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_get"), { thread_id: "t" })
    expect(out.ok).toBe(true)
    expect(out.output).toContain("the goal")
    expect(out.output).toContain("blocked")
    // blockers count surface
    expect(out.output).toMatch(/blockers:?\s*1/i)
    expect(out.output).toContain("do A")
    expect(out.output).toContain("do B")
  })

  test("objective_update returns the NEW state in the output (echo)", async () => {
    const port = createObjectiveStore()
    port.set("t", { goal: "g" })
    const tools = objectiveTools(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "nextActions", actions: ["next thing"] },
    })
    expect(out.ok).toBe(true)
    expect(out.output).toContain("next thing")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. HITL TIER
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — HITL tier (ADR-0402)", () => {
  test("all 3 tools declare hitlTier 'pre-approval-ok'", () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    for (const t of tools) {
      expect(typeof t.hitlTier).toBe("function")
      expect(t.hitlTier?.({} as never)).toBe("pre-approval-ok")
    }
  })

  test("all 3 tools are NOT read-only (they consume the port's intent surface)", () => {
    // objective_get is technically read-only; set/update are not. We treat all
    // three as "information-class" via the HITL tier rather than via the legacy
    // isReadOnly() axis — but the get tool MAY claim isReadOnly() true.
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const get = findTool(tools, "objective_get")
    expect(get.isReadOnly()).toBe(true)
    const setT = findTool(tools, "objective_set")
    expect(setT.isReadOnly()).toBe(false)
    const upd = findTool(tools, "objective_update")
    expect(upd.isReadOnly()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F. THREAD IDENTITY BINDING (RFC-03 §8 stop rule)
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — thread identity is session-bound, never model input", () => {
  test("the model's thread_id argument is IGNORED; ctx.ownerId is authoritative", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    // The model claims thread_id "attacker"; the session owner is "session-x".
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "attacker", goal: "ship it" },
      ctx("session-x"),
    )
    expect(out.ok).toBe(true)
    expect(port.get("session-x")?.goal).toBe("ship it") // bound to the session
    expect(port.get("attacker")).toBeNull() // model-named thread never touched
  })

  test("fails CLOSED when no session-bound owner is present (no model fallback)", async () => {
    const port = createObjectiveStore()
    const tools = objectiveTools(port)
    const bareCtx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }
    const out = await drain(findTool(tools, "objective_set"), { thread_id: "t", goal: "g" }, bareCtx)
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("session-bound")
    expect(port.get("t")).toBeNull() // nothing was written to the model-named thread
  })
})
