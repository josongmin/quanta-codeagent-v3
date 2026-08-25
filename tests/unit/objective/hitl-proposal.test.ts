/**
 * RFC-03 C3 hellgate — model proposal is gated by the EXISTING confirm port.
 *
 * Pins the packet's three receipts on the model write path:
 *
 *   (a) DENIAL CHANGES NOTHING — under `QUANTA_PROPOSE_GOAL` a model
 *       `objective_set` MUST await the confirm port; on DENY nothing commits.
 *   (approve) APPROVAL COMMITS EXACTLY ONCE via CAS.
 *   (fail-closed) missing confirm surface under the gate ⇒ refused, never a
 *       bypass.
 *   (gate-OFF) the confirm port is NEVER consulted and the set commits
 *       byte-identically to the legacy path.
 *   (b) LOCK RELEASED DURING THE WAIT — a concurrent edit performed WHILE the
 *       approval is pending is applied, and the model's post-approval commit is
 *       rejected `stale` (exactly one winner; no clobber).
 *
 * Also pins the host-wire gate: `QUANTA_PROPOSE_GOAL=1` actually flips the
 * authority to gated (the RED baseline: today it does not).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { maybeWireObjective } from "@/host/runtime/objective-store-wire"
import { asObjectiveAuthority, createObjectiveAuthority, type ObjectivePort } from "@/objective"
import type { ObjectiveApprovalRequest, Tool, ToolContext } from "@/tool"
import { objectiveTools } from "@/tool/objective"

const findSet = (auth: ReturnType<typeof createObjectiveAuthority>): Tool => {
  const t = objectiveTools(auth).find((x) => x.name === "objective_set")
  if (t === undefined) throw new Error("objective_set not found")
  return t
}

const drain = async (
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  if (last === undefined) throw new Error("no terminal result")
  return last
}

const ctxWith = (over: Partial<ToolContext>): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ownerId: "t",
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// host-wire gate — the RED baseline this packet closes
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — QUANTA_PROPOSE_GOAL wires the authority gate", () => {
  test("gate ON ⇒ a model proposal requires approval", () => {
    const cfg = {} as AgentConfig & { objective?: ObjectivePort }
    maybeWireObjective(cfg, {
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_PROPOSE_GOAL: "1",
    })
    const auth = asObjectiveAuthority(cfg.objective as ObjectivePort)
    const prepared = auth.prepare({
      threadId: "t",
      actor: "model",
      mutation: { kind: "create", definition: { goal: "g" } },
    })
    expect(prepared.approvalRequired).toBe(true)
  })

  test("gate OFF ⇒ byte-identical legacy (no approval requirement)", () => {
    const cfg = {} as AgentConfig & { objective?: ObjectivePort }
    maybeWireObjective(cfg, { QUANTA_OBJECTIVE_TOOLS: "1" })
    const auth = asObjectiveAuthority(cfg.objective as ObjectivePort)
    const prepared = auth.prepare({
      threadId: "t",
      actor: "model",
      mutation: { kind: "create", definition: { goal: "g" } },
    })
    expect(prepared.approvalRequired).toBe(false)
  })

  test("gate ON but NO confirm authority ⇒ fail-closed (confirmationAvailable false)", () => {
    const cfg = {} as AgentConfig & { objective?: ObjectivePort }
    maybeWireObjective(cfg, { QUANTA_OBJECTIVE_TOOLS: "1", QUANTA_PROPOSE_GOAL: "1" })
    const auth = asObjectiveAuthority(cfg.objective as ObjectivePort)
    const res = auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "model",
        mutation: { kind: "create", definition: { goal: "g" } },
      }),
      { admitted: true }, // even a fabricated receipt cannot bypass a fail-closed surface
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("approval-unavailable")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tool adapter — the model proposal awaits the confirm port
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — objective_set under the gate awaits approval", () => {
  test("(a) DENY changes nothing — the objective is NOT set", async () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    const calls: ObjectiveApprovalRequest[] = []
    const res = await drain(
      findSet(auth),
      { thread_id: "t", goal: "ship the feature" },
      ctxWith({
        requestObjectiveApproval: async (req) => {
          calls.push(req)
          return { admitted: false, note: "not now" }
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(calls.length).toBe(1)
    // GOAL-01: a thread with no objective proposes a `create` (an existing one ⇒ `replace`).
    expect(calls[0]?.operation).toBe("create")
    expect(calls[0]?.goal).toBe("ship the feature")
    expect(auth.get("t")).toBeNull() // denial = no-op
  })

  test("approval commits EXACTLY once (revision advances by 1)", async () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    let calls = 0
    const res = await drain(
      findSet(auth),
      { thread_id: "t", goal: "ship it" },
      ctxWith({
        requestObjectiveApproval: async () => {
          calls += 1
          return { admitted: true }
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(calls).toBe(1)
    expect(auth.get("t")?.goal).toBe("ship it")
    expect(auth.readDomain("t").revision).toBe(1)
  })

  test("(fail-closed) NO confirm surface under the gate ⇒ refused, no commit, no prompt", async () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    const res = await drain(findSet(auth), { thread_id: "t", goal: "g" }, ctxWith({}))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("no confirmation surface")
    expect(auth.get("t")).toBeNull()
  })

  test("(gate-OFF) the confirm port is NEVER consulted and the set commits", async () => {
    const auth = createObjectiveAuthority({ gateOn: false })
    let consulted = false
    const res = await drain(
      findSet(auth),
      { thread_id: "t", goal: "g" },
      ctxWith({
        requestObjectiveApproval: async () => {
          consulted = true
          return { admitted: false }
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(consulted).toBe(false)
    expect(auth.get("t")?.goal).toBe("g")
  })

  test("(b) LOCK RELEASED during the wait — a concurrent edit wins, the model commit is stale", async () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    // seed an objective so a concurrent edit has something to bump
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "create", definition: { goal: "seed" } },
      }),
      { admitted: true },
    )
    const revBefore = auth.readDomain("t").revision
    const res = await drain(
      findSet(auth),
      { thread_id: "t", goal: "model-goal" },
      ctxWith({
        requestObjectiveApproval: async () => {
          // WHILE the approval is pending, a concurrent user/CLI edit commits.
          // If the tool held the store lock across the await this could not run.
          const p = auth.prepare({
            threadId: "t",
            actor: "user",
            mutation: { kind: "replace", definition: { goal: "cli-goal" } },
          })
          const cli = auth.commit(p, { admitted: true })
          expect(cli.ok).toBe(true)
          return { admitted: true }
        },
      }),
    )
    // The model's post-approval commit prepared at the OLD revision ⇒ stale.
    expect(res.ok).toBe(false)
    expect(res.output).toContain("stale")
    // Exactly one winner: the concurrent CLI edit; no clobber back to model-goal.
    expect(auth.get("t")?.goal).toBe("cli-goal")
    expect(auth.readDomain("t").revision).toBe(revBefore + 1)
  })

  test("a model self-completion is refused WITHOUT prompting (forbidden-completion)", async () => {
    const auth = createObjectiveAuthority({ gateOn: true })
    auth.commit(
      auth.prepare({
        threadId: "t",
        actor: "system",
        mutation: { kind: "create", definition: { goal: "g", successCriteria: ["done"] } },
      }),
      { admitted: true },
    )
    const cid = auth.get("t")?.successCriteria[0]?.id ?? ""
    const update = objectiveTools(auth).find((x) => x.name === "objective_update")
    if (update === undefined) throw new Error("objective_update not found")
    let consulted = false
    const res = await drain(
      update,
      { thread_id: "t", op: { kind: "markCriterion", criterion_id: cid, met: true } },
      ctxWith({
        requestObjectiveApproval: async () => {
          consulted = true
          return { admitted: true }
        },
      }),
    )
    expect(res.ok).toBe(false)
    expect(consulted).toBe(false) // structurally forbidden — never prompts
    expect(auth.get("t")?.successCriteria[0]?.met).toBe(false)
  })
})
