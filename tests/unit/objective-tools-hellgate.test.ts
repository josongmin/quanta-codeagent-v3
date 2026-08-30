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
 *      malformed input (unknown op / bad enum / retired op) yields a typed
 *      `ok:false` (NEVER throws past the loop). GOAL-02: `thread_id` is
 *      optional and IGNORED — only a missing session binding (`ctx.ownerId`)
 *      fails, and it fails CLOSED.
 *
 *   C. NO-THROW / OUTPUT — a throwing fake port must surface as `ok:false`,
 *      `objective_get` returns "no objective" string for unknown thread, and
 *      the rendered text contains goal + status + blockers-count + nextActions.
 *
 * GOAL-02: the tools are built over the ACTOR-FIXED model capability
 * (`createObjectiveCapabilities(port).model` + `.read`), never the raw
 * authority. The model may only PROPOSE a `create` (approval under the propose
 * gate; `actor-forbidden` when the gate is OFF) and issue `addBlocker` /
 * `nextActions`; status, criterion completion, blocker clearing and usage are
 * host-owned and are rejected at the zod boundary.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { buildObjectiveBlock } from "@/agent/tier1"
import type { AgentConfig, FeaturesConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import {
  asObjectiveAuthority,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  createObjectiveStore,
  type ObjectivePort,
} from "@/objective"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { DecisionEvent, StreamPort } from "@/stream"
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

/** GOAL-02 — a session context whose confirm surface ADMITS every proposal, so
 *  a gated model `create` can commit (the only way a model `objective_set` lands). */
const approvingCtx = (ownerId = "t"): ToolContext => ({
  ...ctx(ownerId),
  requestObjectiveApproval: async () => ({ admitted: true }),
})

/** GOAL-02 — build the trio the way the composition root does: over the
 *  actor-fixed MODEL capability + the read port (never the raw authority). */
const toolsOver = (port: ObjectivePort): Tool[] => {
  const caps = createObjectiveCapabilities(port)
  return objectiveTools({ model: caps.model, read: caps.read })
}

/** GOAL-02 — a port whose propose gate is ON (model `create` is an approval proposal). */
const gatedPort = (): ObjectivePort => createObjectiveAuthority({ gateOn: true })

// GOAL-02: the model-facing refusal strings (`COMMIT_ERROR_MESSAGE` in
// src/tool/objective/index.ts) the reversed cases assert on.
const MSG_ACTOR_FORBIDDEN = "this mutation is not available to the model"
const MSG_OBJECTIVE_EXISTS =
  "an objective already exists for this thread — use objective_update, or ask the user to edit the goal"

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

  // GOAL-02 (REVERSED): this case used to seed through the model's `objective_set`
  // on a gate-OFF store. A gate-OFF model `create` is now REFUSED by the policy
  // (`actor-forbidden`), so the objective is seeded through the PORT and the
  // same-instance binding is proven both ways: the builder's `objective_get`
  // reads the port-seeded goal, and its `objective_update` writes back into the
  // very same port.
  test("(6) builder binds to the SAME port (port seed ⇒ get; update ⇒ port read-back)", async () => {
    const port = createObjectiveStore()
    const tools = buildObjectiveBlock(baseCfg({ objective: port }))
    const setTool = findTool(tools, "objective_set")
    const getTool = findTool(tools, "objective_get")
    const updateTool = findTool(tools, "objective_update")
    const setOut = await drain(setTool, { thread_id: "t1", goal: "ship it" }, ctx("t1"))
    expect(setOut.ok).toBe(false)
    expect(setOut.output).toBe(MSG_ACTOR_FORBIDDEN)
    expect(port.get("t1")).toBeNull()
    expect(port.create("t1", { goal: "ship it" })).not.toBeNull()
    const getOut = await drain(getTool, { thread_id: "t1" }, ctx("t1"))
    expect(getOut.ok).toBe(true)
    expect(getOut.output).toContain("ship it")
    const updOut = await drain(
      updateTool,
      { thread_id: "t1", op: { kind: "nextActions", actions: ["via builder"] } },
      ctx("t1"),
    )
    expect(updOut.ok).toBe(true)
    expect(port.get("t1")?.nextActions).toEqual(["via builder"])
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
  // GOAL-01 (REVERSED): there is no explicit `completed` intent any more —
  // completion is DERIVED from criteria evidence. The `status:"completed"` op is
  // rejected at the zod boundary, so the reject-mode judge is NEVER consulted and
  // NO decision event is emitted. The protective intent (criterion text never
  // leaks through the decision port) is kept: nothing is emitted at all.
  // GOAL-02: the whole `status` op is gone from the schema and the judge is a
  // shadow observer with no admission power (`QUANTA_GOAL_JUDGE=reject` parses
  // to `off`) — the assertions hold a fortiori.
  test("reject-mode judge is NOT triggered by the retired explicit-completed op (schema rejection, no telemetry)", async () => {
    const prior = process.env.QUANTA_GOAL_JUDGE
    process.env.QUANTA_GOAL_JUDGE = "reject"
    __resetRuntimeConfig()
    try {
      const port = createObjectiveStore()
      port.create("t", { goal: "never-leak-this-criterion", criteria: [{ text: "manual proof" }] })
      const emitted: DecisionEvent[] = []
      let judgeCalls = 0
      const llm: LLMPort = {
        model: "judge-model",
        async *stream() {
          judgeCalls += 1
          yield {
            type: "text_delta",
            delta:
              '{"decision":"abstain","unmetCriterionIds":[],"evidenceRefs":[],"reasonCodes":["insufficient-evidence"]}',
          }
        },
      }
      const tools = buildObjectiveBlock(
        baseCfg({
          objective: port,
          llm,
          decisionEmitter: { emit: (event) => emitted.push(event) },
        }),
      )
      const out = await drain(findTool(tools, "objective_update"), {
        thread_id: "t",
        op: { kind: "status", status: "completed" },
      })
      expect(out.ok).toBe(false)
      expect(out.output).toContain("invalid input")
      expect(judgeCalls).toBe(0)
      expect(emitted).toHaveLength(0)
      expect(JSON.stringify(emitted)).not.toContain("never-leak-this-criterion")
      expect(port.get("t")?.status).toBe("active")
    } finally {
      if (prior === undefined) delete process.env.QUANTA_GOAL_JUDGE
      else process.env.QUANTA_GOAL_JUDGE = prior
      __resetRuntimeConfig()
    }
  })

  // GOAL-01 (REVERSED): the completion-admission port has no trigger in the tool
  // any more (no explicit completed). GOAL-02: the admission parameter itself is
  // GONE from `objectiveTools` (the LLM judge is telemetry-only), so there is no
  // admission to consult at all — the op fails at the schema and the objective
  // is untouched.
  test("completion admission does not exist: the explicit-completed op is a schema rejection", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "g" })
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "status", status: "completed" },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(out.output).not.toContain("judge-block")
    expect(port.get("t")?.status).toBe("active")
  })

  // GOAL-01 (REVERSED): with no admission trigger there is no admission revision
  // to bind into the CAS. GOAL-02: no admission path exists at all — the store
  // stays at its seeded revision and status, and no side effect can ride along.
  test("the retired explicit-completed op leaves the revision untouched (no admission path exists)", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "g" })
    const authority = asObjectiveAuthority(port)
    const revisionBefore = authority.readDomain("t").revision
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "status", status: "completed" },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(out.output).not.toContain("stale")
    expect(authority.readDomain("t").revision).toBe(revisionBefore)
    expect(port.get("t")?.status).toBe("active")
    expect(port.get("t")?.blockers).toEqual([])
  })

  test("objective_set requires non-empty goal", async () => {
    const port = createObjectiveStore()
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_set"), { thread_id: "t", goal: "" })
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("invalid")
  })

  // GOAL-02 (REVERSED): `thread_id` is deprecated and IGNORED — a payload
  // without it passes validation and the proposal lands on the SESSION-bound
  // thread. The protective intent moves to the session binding: only a missing
  // `ctx.ownerId` fails, and it fails CLOSED (nothing written anywhere).
  test("objective_set ACCEPTS a missing thread_id (session-bound); a missing ctx.ownerId fails closed", async () => {
    const port = gatedPort()
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_set"), { goal: "g" }, approvingCtx("t"))
    expect(out.ok).toBe(true)
    expect(port.get("t")?.goal).toBe("g")
    const bare = createObjectiveStore()
    const bareCtx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }
    const refused = await drain(findTool(toolsOver(bare), "objective_set"), { goal: "g" }, bareCtx)
    expect(refused.ok).toBe(false)
    expect(refused.output.toLowerCase()).toContain("session-bound")
    expect(bare.list()).toEqual([])
  })

  test("objective_update rejects unknown op kind", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "g" })
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "wizardry" },
    })
    expect(out.ok).toBe(false)
  })

  test("objective_update rejects bad enum (waiting_on)", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "g" })
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "addBlocker", reason: "x", waiting_on: "moon" },
    })
    expect(out.ok).toBe(false)
  })

  // GOAL-02 (REVERSED): the `status` op is REMOVED from the model schema
  // altogether (status is host-owned) — a bad enum AND a well-formed
  // `active|paused` are both "invalid input", and the objective is untouched.
  test("objective_update rejects the status op outright (bad enum AND well-formed)", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "g" })
    const tools = toolsOver(port)
    for (const status of ["halfway", "paused", "active"]) {
      const out = await drain(findTool(tools, "objective_update"), {
        thread_id: "t",
        op: { kind: "status", status },
      })
      expect(out.ok).toBe(false)
      expect(out.output).toContain("invalid input")
    }
    expect(port.get("t")?.status).toBe("active")
  })

  // GOAL-02 (REVERSED): `thread_id` is optional on `objective_get` too — `{}`
  // reads the session-bound thread; only a missing `ctx.ownerId` is refused.
  test("objective_get ACCEPTS a missing thread_id (session-bound); a missing ctx.ownerId fails closed", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "bound goal" })
    const tools = toolsOver(port)
    const out = await drain(findTool(tools, "objective_get"), {})
    expect(out.ok).toBe(true)
    expect(out.output).toContain("bound goal")
    const bareCtx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }
    const refused = await drain(findTool(tools, "objective_get"), {}, bareCtx)
    expect(refused.ok).toBe(false)
    expect(refused.output.toLowerCase()).toContain("session-bound")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. OP VARIANT ROUND-TRIP
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — op variant round-trip (ADR-0402)", () => {
  // GOAL-02: seeded through the PORT (system actor) — a gate-OFF model
  // `objective_set` is refused by the policy, so the model tool can no longer
  // seed its own objective here.
  const seed = async (): Promise<{ port: ObjectivePort; tools: readonly Tool[] }> => {
    const port = createObjectiveStore()
    const created = port.create("t", {
      goal: "build feature",
      successCriteria: ["tests pass", "tsc 0"],
    })
    if (created === null) throw new Error("seed refused")
    return { port, tools: toolsOver(port) }
  }

  // GOAL-02 (REVERSED): the `status` op used to route to `setExplicitStatus`.
  // Status is HOST-owned now — the model op is a schema rejection and the
  // objective stays active; the USER capability still pauses/resumes it.
  test("status op is REJECTED for the model (host-owned); the user capability still pauses/resumes", async () => {
    const { port, tools } = await seed()
    const paused = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "status", status: "paused" },
    })
    expect(paused.ok).toBe(false)
    expect(paused.output).toContain("invalid input")
    expect(port.get("t")?.status).toBe("active")
    const user = createObjectiveCapabilities(port).user
    expect(user.commit("t", { kind: "setExplicitStatus", status: "paused" }).ok).toBe(true)
    expect(port.get("t")?.status).toBe("paused")
    expect(user.commit("t", { kind: "setExplicitStatus", status: "active" }).ok).toBe(true)
    expect(port.get("t")?.status).toBe("active")
  })

  // GOAL-01 (REVERSED): this test used to prove `status:"completed"` routed to
  // `updateStatus` and flipped the objective to completed. Completed is DERIVED
  // only now; the explicit op is rejected by the schema and the store is untouched.
  test("status op REJECTS the retired explicit 'completed' (derived-only status)", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "status", status: "completed" },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(port.get("t")?.status).toBe("active")
  })

  // GOAL-02 (REVERSED): `objective_set` on a live objective used to REPLACE it
  // (fresh objectiveId, evidence reset). The definition is user-owned now: the
  // model always proposes a `create`, and on a live thread the domain answers
  // `objective-exists` — same objectiveId, criteria evidence intact. (Only ONE
  // of two criteria is marked so the objective stays `active`, not terminal.)
  test("objective_set on a live objective is REFUSED `objective-exists` (no replace, evidence intact)", async () => {
    const port = gatedPort()
    const first = port.create("t", {
      goal: "build feature",
      successCriteria: ["tests pass", "tsc 0"],
    })
    if (first === null) throw new Error("seed refused")
    const cid = first.successCriteria[0]?.id ?? ""
    port.markCriterion("t", cid, true)
    expect(port.get("t")?.successCriteria[0]?.met).toBe(true)
    expect(port.get("t")?.status).toBe("active")
    const tools = toolsOver(port)
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "t", goal: "a replaced goal", success_criteria: ["fresh criterion"] },
      approvingCtx("t"),
    )
    expect(out.ok).toBe(false)
    expect(out.output).toBe(MSG_OBJECTIVE_EXISTS)
    const second = port.get("t")
    expect(second?.goal).toBe("build feature")
    expect(second?.objectiveId).toBe(first.objectiveId)
    expect(second?.successCriteria.map((c) => c.met)).toEqual([true, false])
  })

  test("addBlocker promotes only after three distinct host-attributed attempts", async () => {
    const { port, tools } = await seed()
    const input = {
      thread_id: "t",
      op: {
        kind: "addBlocker" as const,
        reason: "needs key",
        waiting_on: "user" as const,
        dependency_target: { kind: "approval" as const, ref: "deploy-key" },
      },
    }
    // GOAL P0-A — the attempts are the HOST's, reserved through the system
    // capability. The tool context carries no attempt identity at all: a ctx
    // field the model's turn could vary was never an attempt.
    const system = createObjectiveCapabilities(port).system
    const enterAttempt = (attemptId: string): void => {
      const objective = port.get("t")
      if (objective === null) throw new Error("no objective")
      if (objective.attempts.started !== undefined) {
        system.commit("t", { kind: "abandonAttempt" })
      }
      system.commit("t", {
        kind: "beginAttempt",
        attempt: {
          objectiveId: objective.objectiveId,
          attemptId,
          provenance: "user-requested-goal-work",
          executionMode: "foreground",
          startedRevision: asObjectiveAuthority(port).readDomain("t").revision,
        },
      })
    }

    enterAttempt("attempt-1")
    expect((await drain(findTool(tools, "objective_update"), input, ctx())).ok).toBe(true)
    expect(port.get("t")?.status).toBe("active")
    enterAttempt("attempt-2")
    expect((await drain(findTool(tools, "objective_update"), input, ctx())).ok).toBe(true)
    enterAttempt("attempt-3")
    const out = await drain(findTool(tools, "objective_update"), input, ctx())
    expect(out.ok).toBe(true)
    const o = port.get("t")
    expect(o?.status).toBe("blocked")
    expect(o?.blockers.length).toBe(1)
  })

  // GOAL-02 (REVERSED): `clearBlocker` is no longer a model op — the model may
  // RAISE a blocker but only the user/system may clear one. The op is a schema
  // rejection, the blocker stays, and the user capability clears it.
  test("clearBlocker op is REJECTED for the model; the user capability clears it", async () => {
    const { port, tools } = await seed()
    port.addBlocker("t", { reason: "x", waitingOn: "tool" })
    const blockerId = port.get("t")?.blockers[0]?.id ?? ""
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "clearBlocker", blocker_id: blockerId },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(port.get("t")?.blockers.length).toBe(1)
    const user = createObjectiveCapabilities(port).user
    expect(user.commit("t", { kind: "clearBlocker", blockerId }).ok).toBe(true)
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

  // GOAL-02 (REVERSED): `markCriterion` is no longer a model op — a manual
  // criterion is completed ONLY by user attestation. The op is a schema
  // rejection and the criterion stays unmet; the user capability marks it.
  test("markCriterion op is REJECTED for the model; the user capability attests it", async () => {
    const { port, tools } = await seed()
    const cid = port.get("t")?.successCriteria[0]?.id ?? ""
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "markCriterion", criterion_id: cid, met: true },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(port.get("t")?.successCriteria[0]?.met).toBe(false)
    const user = createObjectiveCapabilities(port).user
    expect(user.commit("t", { kind: "markCriterion", criterionId: cid, met: true }).ok).toBe(true)
    expect(port.get("t")?.successCriteria[0]?.met).toBe(true)
  })

  // GOAL-01 (REVERSED): usage is HOST-measured (`settleAttempt`), never self-
  // reported by the model. The `recordUsage` op is gone from the schema: it is
  // rejected as invalid input and the budget counters are untouched.
  test("recordUsage op is REJECTED (usage is host-measured, never self-reported)", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "recordUsage", tokens: 100, turns: 2 },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    const o = port.get("t")
    expect(o?.budget.tokensUsed).toBe(0)
    expect(o?.budget.turnsUsed).toBe(0)
  })

  test("recordUsage tokens-only is REJECTED too (no partial self-report path)", async () => {
    const { port, tools } = await seed()
    const out = await drain(findTool(tools, "objective_update"), {
      thread_id: "t",
      op: { kind: "recordUsage", tokens: 50 },
    })
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(port.get("t")?.budget.tokensUsed).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. NO-THROW + OUTPUT SHAPE
// ─────────────────────────────────────────────────────────────────────────────

describe("objective tools — NO-THROW + output shape (ADR-0402)", () => {
  /** A hostile port — every method throws. The tool must NEVER bubble it. */
  const throwingPort = (): ObjectivePort =>
    ({
      create() {
        throw new Error("boom")
      },
      replace() {
        throw new Error("boom")
      },
      clear() {
        throw new Error("boom")
      },
      get() {
        throw new Error("boom")
      },
      setExplicitStatus() {
        throw new Error("boom")
      },
      amendBudget() {
        throw new Error("boom")
      },
      markUsageLimited() {
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

  // GOAL-02: a gate-ON authority over the hostile port so the model `create`
  // reaches the port (gate-OFF would be refused by the policy before touching it).
  const throwingGated = (): ObjectivePort => asObjectiveAuthority(throwingPort(), { gateOn: true })

  test("throwing port.create ⇒ ok:false (never bubbles)", async () => {
    const tools = toolsOver(throwingGated())
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "t", goal: "g" },
      approvingCtx("t"),
    )
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("error")
  })

  test("throwing port.get ⇒ ok:false (never bubbles)", async () => {
    const tools = toolsOver(throwingPort())
    const out = await drain(findTool(tools, "objective_get"), { thread_id: "t" })
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("error")
  })

  test("foreign port without observation provenance fails closed without bubbling", async () => {
    const tools = toolsOver(throwingPort())
    const out = await drain(
      findTool(tools, "objective_update"),
      {
        thread_id: "t",
        op: {
          kind: "addBlocker",
          reason: "x",
          waiting_on: "tool",
          dependency_target: { kind: "tool", ref: "remote" },
        },
      },
      { ...ctx(), toolCallId: "call-1" },
    )
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("error")
  })

  test("objective_get for unknown thread ⇒ ok:false 'no objective set for thread <id>'", async () => {
    const port = createObjectiveStore()
    const tools = toolsOver(port)
    const out = await drain(
      findTool(tools, "objective_get"),
      { thread_id: "missing" },
      ctx("missing"),
    )
    expect(out.ok).toBe(false)
    expect(out.output).toContain("no objective set for thread missing")
  })

  // GOAL-02: the model's `objective_set` commits only as an APPROVED proposal
  // under the propose gate — the rendered echo is asserted on that path.
  test("objective_set rendered output contains goal + status", async () => {
    const port = gatedPort()
    const tools = toolsOver(port)
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "t", goal: "ship feature X" },
      approvingCtx("t"),
    )
    expect(out.ok).toBe(true)
    expect(out.output).toContain("ship feature X")
    expect(out.output).toContain("active")
  })

  test("objective_get output contains goal + status + blockers count + nextActions", async () => {
    const port = createObjectiveStore()
    port.create("t", { goal: "the goal" })
    port.addBlocker("t", { reason: "waiting", waitingOn: "user" })
    port.setNextActions("t", ["do A", "do B"])
    const tools = toolsOver(port)
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
    port.create("t", { goal: "g" })
    const tools = toolsOver(port)
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
    const tools = toolsOver(port)
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
    const tools = toolsOver(port)
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
  // GOAL-02: the proposal commits only under the propose gate with an admitting
  // confirm surface — the binding assertion is unchanged.
  test("the model's thread_id argument is IGNORED; ctx.ownerId is authoritative", async () => {
    const port = gatedPort()
    const tools = toolsOver(port)
    // The model claims thread_id "attacker"; the session owner is "session-x".
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "attacker", goal: "ship it" },
      approvingCtx("session-x"),
    )
    expect(out.ok).toBe(true)
    expect(port.get("session-x")?.goal).toBe("ship it") // bound to the session
    expect(port.get("attacker")).toBeNull() // model-named thread never touched
  })

  test("fails CLOSED when no session-bound owner is present (no model fallback)", async () => {
    const port = gatedPort()
    const tools = toolsOver(port)
    const bareCtx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      requestObjectiveApproval: async () => ({ admitted: true }),
    }
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "t", goal: "g" },
      bareCtx,
    )
    expect(out.ok).toBe(false)
    expect(out.output.toLowerCase()).toContain("session-bound")
    expect(port.get("t")).toBeNull() // nothing was written to the model-named thread
    expect(port.list()).toEqual([])
  })

  // GOAL-02: gate OFF ⇒ a model `create` is refused by the ONE policy table
  // (`actor-forbidden`) — the confirm port is never consulted and nothing lands.
  test("gate OFF ⇒ objective_set is REFUSED (actor-forbidden), no prompt, nothing written", async () => {
    const port = createObjectiveStore()
    const tools = toolsOver(port)
    let consulted = false
    const out = await drain(
      findTool(tools, "objective_set"),
      { thread_id: "t", goal: "g" },
      {
        ...ctx("t"),
        requestObjectiveApproval: async () => {
          consulted = true
          return { admitted: true }
        },
      },
    )
    expect(out.ok).toBe(false)
    expect(out.output).toBe(MSG_ACTOR_FORBIDDEN)
    expect(consulted).toBe(false)
    expect(port.get("t")).toBeNull()
  })
})
