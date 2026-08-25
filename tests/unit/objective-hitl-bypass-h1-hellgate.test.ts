/**
 * RFC-03 H1 (HIGH, security — HITL bypass) HELLGATE.
 *
 * BASE DEFECT: `resolveObservabilityWire` minted an UNGATED objective authority
 * onto `base.objective` whenever `QUANTA_OBSERVABILITY=on`. Because `base` is
 * spread into the assembled config BEFORE `wireOptionalCapabilitySlots`,
 * `maybeWireObjective` hits its `if (slot.objective !== undefined) return`
 * caller-override guard and NEVER applies the gated wiring. Net: with
 * QUANTA_OBSERVABILITY=on + QUANTA_OBJECTIVE_TOOLS=1 + QUANTA_PROPOSE_GOAL=1 a
 * model-originated `objective_set` committed with NO approval — the exact
 * autonomous-goal-set door RFC-03 closes. AND `objective_*` tools leaked under
 * QUANTA_OBSERVABILITY alone (features.ts composes them whenever
 * `config.objective` is set), even with QUANTA_OBJECTIVE_TOOLS off.
 *
 * FIX: the observability wire no longer mints/sets `base.objective`. The ONE
 * per-session objective authority is built by the gated `maybeWireObjective`
 * (behind QUANTA_OBJECTIVE_TOOLS + QUANTA_PROPOSE_GOAL); the assembler late-binds
 * it onto the observability ApprovalStateMachine so attribution is preserved.
 *
 * This pins the ASSEMBLED config's objective authority is CORRECTLY GATED and
 * that tools only appear under QUANTA_OBJECTIVE_TOOLS.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildBaseFromArgs } from "@/../src/apps/agent/index"
import { buildSessionFeatures } from "@/agent/features"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { asObjectiveAuthority } from "@/objective"

const OBJ_GATES = ["QUANTA_OBSERVABILITY", "QUANTA_OBJECTIVE_TOOLS", "QUANTA_PROPOSE_GOAL"] as const

describe("RFC-03 H1 — observability must not mint an ungated objective authority", () => {
  let snapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    snapshot = { ...process.env }
    process.env.OPENAI_API_KEY = "test-openai-key"
    delete process.env.QUANTA_PROVIDER
    for (const g of OBJ_GATES) delete process.env[g]
  })
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key]
    }
    Object.assign(process.env, snapshot)
  })

  /** Assemble the full config the way a surface does: build the base (which is
   *  where the observability slots are resolved), then hand it — with a live
   *  `onConfirm` confirmation authority — to `assembleAgentConfig`. */
  const assembleWithConfirm = (over: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(over)) process.env[k] = v
    const base = buildBaseFromArgs({ mode: "interactive", dials: {} })
    const req: AssembleRequest = {
      mode: "interactive",
      // A live surface confirm authority ⇒ `confirmationAvailable` is true, so a
      // gated authority mediates (not the fail-closed approval-unavailable arm).
      base: { ...base, onConfirm: async () => true } as AssembleRequest["base"],
    }
    return { base, cfg: assembleAgentConfig(req, process.env) }
  }

  test("[H1-1] OBSERVABILITY+TOOLS+PROPOSE_GOAL ⇒ a model set is APPROVAL-GATED (no silent commit)", () => {
    const { base, cfg } = assembleWithConfirm({
      QUANTA_OBSERVABILITY: "on",
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_PROPOSE_GOAL: "1",
    })
    expect(cfg.objective).toBeDefined()
    const authority = asObjectiveAuthority(cfg.objective as NonNullable<typeof cfg.objective>)
    const threadId = base.sessionId ?? "s1"
    const prepared = authority.prepare({
      threadId,
      actor: "model",
      mutation: { kind: "create", definition: { goal: "autonomous pwn goal" } },
    })
    // GATED: a model mutation REQUIRES an admitted approval.
    expect(prepared.approvalRequired).toBe(true)
    // And an un-admitted commit is REFUSED (the HITL bypass is closed).
    const res = authority.commit(prepared, { admitted: false })
    expect(res.ok).toBe(false)
  })

  test("[H1-2] exactly ONE authority: the ASM attributes to the SAME objective the tools mutate", () => {
    const { base, cfg } = assembleWithConfirm({
      QUANTA_OBSERVABILITY: "on",
      QUANTA_OBJECTIVE_TOOLS: "1",
      QUANTA_PROPOSE_GOAL: "1",
    })
    const objective = cfg.objective
    const asm = cfg.approvalStateMachine
    expect(objective).toBeDefined()
    expect(asm).toBeDefined()
    const threadId = base.sessionId ?? "s1"
    // Seed an objective through the tools' authority surface (system actor).
    objective?.create(threadId, { goal: "ship", successCriteria: ["compiles"] })
    // The ASM records an approval PAUSE on THIS thread — its attribution
    // (`addBlocker`) must land on the SAME objective instance (bind-once
    // late-bind), proving there are not two divergent authorities.
    const rec = asm?.request({
      threadId,
      kind: "permission",
      reason: "writes outside cwd",
      proposedAction: "rm -rf build/",
      resumeStep: "s",
    })
    expect(rec).toBeDefined()
    // A PENDING approval added a blocker to the shared authority (attribution live).
    expect(objective?.get(threadId)?.blockers.length).toBe(1)
    // Settling the approval CLEARS that same blocker on the same authority.
    if (rec !== undefined) asm?.settle(rec.id, "deny")
    expect(objective?.get(threadId)?.blockers.length).toBe(0)
  })

  test("[H1-3] OBSERVABILITY alone (TOOLS off) ⇒ NO objective authority, NO objective_* tools leak", async () => {
    const { cfg } = assembleWithConfirm({ QUANTA_OBSERVABILITY: "on" })
    // No tools gate ⇒ the single-authority path never runs ⇒ slot unset.
    expect(cfg.objective).toBeUndefined()
    const toolNames = (await buildSessionFeatures(cfg)).extraTools.map((t) => t.name)
    expect(toolNames).not.toContain("objective_set")
    expect(toolNames).not.toContain("objective_update")
    expect(toolNames).not.toContain("objective_get")
  })

  test("[H1-4] all three gates absent ⇒ objective UNSET (default-OFF byte-identity)", () => {
    const { cfg } = assembleWithConfirm({})
    expect(cfg.objective).toBeUndefined()
  })
})
