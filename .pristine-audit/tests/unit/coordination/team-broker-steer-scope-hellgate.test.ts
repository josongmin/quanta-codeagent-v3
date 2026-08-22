/**
 * ★ HELLGATE — WS-A (jul-10 uiux structural, UUX-1-07): the leader's RICH
 *   decision must survive the broker boundary.
 *
 * Pinned bug: `subagent-runner`'s leaderDecide collapsed the leader's
 * normalized ConfirmDecision to `{approved: boolean}` — a `deny_and_steer`
 * lost its corrective steer (the worker got a bare "Permission denied" with
 * no guidance) and an `allow` lost its once/session scope (a session-scoped
 * allow re-escalated to the leader on every call).
 *
 * Structural fix under test:
 *   - `EscalationDecision` deny arm carries `steer?`, allow arm carries `scope?`
 *   - `applyDecisionResponse` (worker-side accept seam) round-trips both
 *   - `buildLeaderDecide` (SSOT mapping, exported from coordination-broker-wire)
 *     maps ConfirmDecision → EscalationDecision and caches session-scoped allows
 *   - the gate's broker-deny arm surfaces the steer via the EXISTING
 *     `denyFromConfirm` mechanism (`DispatchResult.steerInjection`)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import {
  type AdmissibilityAction,
  type GateEscalationBroker,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import { buildLeaderDecide, buildLeaderHitlBroker } from "@/agent/coordination-broker-wire"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetDefaultPermissionStore, type AutoModeClassifier } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { applyDecisionResponse } from "@/subagent/coordination"
import { type Tool, ToolRegistry } from "@/tool"

// ── fixtures (mirror team-broker-gate-escalation-hellgate.test.ts) ────────────

const makeMutatingTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfg = (over: Record<string, unknown> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

const actionOf = (tool: Tool, input: unknown): AdmissibilityAction => ({
  tool: tool.name,
  input,
  isReadOnly: tool.isReadOnly(),
})

const denyClassifier = (reason: string): AutoModeClassifier =>
  ({
    evaluate: async () => ({ verdict: "deny", reason, fallback: false }),
  }) as unknown as AutoModeClassifier

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "team-broker-steer-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const write = makeMutatingTool("write")

// ── wire round-trip: applyDecisionResponse preserves steer + scope ────────────

describe("HELLGATE WS-A — applyDecisionResponse round-trips the rich decision", () => {
  const msg = (body: unknown) => ({
    from: "leader",
    to: "worker",
    kind: "response" as const,
    body: JSON.stringify(body),
    correlationId: "c1",
  })

  test("deny carries steer through the worker-side accept seam", () => {
    const applied = applyDecisionResponse(
      msg({ approved: false, reason: "no", steer: "use `bun test` instead of raw pytest" }),
      "c1",
      { leaderId: "leader" },
    )
    expect(applied).toEqual({
      approved: false,
      reason: "no",
      steer: "use `bun test` instead of raw pytest",
    })
  })

  test("allow carries a session scope through the worker-side accept seam", () => {
    const applied = applyDecisionResponse(msg({ approved: true, scope: "session" }), "c1", {
      leaderId: "leader",
    })
    expect(applied).toEqual({ approved: true, scope: "session" })
  })

  test("a forged/garbage scope literal is DROPPED (never widens beyond the vocabulary)", () => {
    const applied = applyDecisionResponse(msg({ approved: true, scope: "everything" }), "c1", {
      leaderId: "leader",
    })
    expect(applied).toEqual({ approved: true })
  })

  test("a non-string steer is DROPPED (validation, not passthrough)", () => {
    const applied = applyDecisionResponse(
      msg({ approved: false, reason: "no", steer: { evil: true } }),
      "c1",
      { leaderId: "leader" },
    )
    expect(applied).toEqual({ approved: false, reason: "no" })
  })
})

// ── SSOT mapping: buildLeaderDecide (ConfirmDecision → EscalationDecision) ────

describe("HELLGATE WS-A — buildLeaderDecide maps the leader's ConfirmDecision losslessly", () => {
  const req = { tool: "shell", scope: "exec:git push", reason: "needs push" }

  test("deny_and_steer ⇒ {approved:false, steer} (the steer reaches the worker)", async () => {
    const decide = buildLeaderDecide(async () => ({
      decision: "deny_and_steer" as const,
      steer: "push to a feature branch instead",
    }))
    expect(await decide(req)).toEqual({
      approved: false,
      reason: "needs push",
      steer: "push to a feature branch instead",
    })
  })

  test("allow with session scope ⇒ {approved:true, scope:'session'}", async () => {
    const decide = buildLeaderDecide(async () => ({
      decision: "allow" as const,
      scope: "session" as const,
    }))
    expect(await decide(req)).toEqual({ approved: true, scope: "session" })
  })

  test("legacy boolean true ⇒ {approved:true} (byte-identical)", async () => {
    const decide = buildLeaderDecide(async () => true)
    expect(await decide(req)).toEqual({ approved: true })
  })

  test("legacy boolean false ⇒ {approved:false, reason} (byte-identical)", async () => {
    const decide = buildLeaderDecide(async () => false)
    expect(await decide(req)).toEqual({ approved: false, reason: "needs push" })
  })

  test("a SESSION-scoped allow is cached: the same tool+scope never re-prompts the leader", async () => {
    let asks = 0
    const decide = buildLeaderDecide(async () => {
      asks += 1
      return { decision: "allow" as const, scope: "session" as const }
    })
    expect(await decide(req)).toEqual({ approved: true, scope: "session" })
    expect(await decide(req)).toEqual({ approved: true, scope: "session" })
    expect(asks).toBe(1) // second call served from the standing grant
  })

  test("a ONCE allow is NOT cached — every ask goes back to the leader", async () => {
    let asks = 0
    const decide = buildLeaderDecide(async () => {
      asks += 1
      return { decision: "allow" as const, scope: "once" as const }
    })
    await decide(req)
    await decide(req)
    expect(asks).toBe(2)
  })

  test("a DENY is never cached — the worker may re-ask after changing approach", async () => {
    let asks = 0
    const decide = buildLeaderDecide(async () => {
      asks += 1
      return false
    })
    await decide(req)
    await decide(req)
    expect(asks).toBe(2)
  })

  test("the cache is keyed by tool+scope — a different command re-prompts", async () => {
    let asks = 0
    const decide = buildLeaderDecide(async () => {
      asks += 1
      return { decision: "allow" as const, scope: "session" as const }
    })
    await decide(req)
    await decide({ ...req, scope: "exec:git fetch" })
    expect(asks).toBe(2)
  })
})

// ── wire END-TO-END: buildLeaderHitlBroker must not re-collapse the decision ──
// Adversarial pin (self-audit R2): the wire's escalate() tail used to rebuild a
// bare `{approved}` from the applied decision — even with the decider + accept
// seam fixed, the rich fields died on this LAST hop. Drive the real wire.

describe("HELLGATE WS-A — buildLeaderHitlBroker round-trips steer + scope end-to-end", () => {
  const req = { tool: "shell", scope: "exec:git push", reason: "needs push" }

  test("leader deny_and_steer survives the full wire (decider → serialize → apply → escalate)", async () => {
    const broker = buildLeaderHitlBroker({
      workerId: "w",
      leaderId: "L",
      leaderDecide: buildLeaderDecide(async () => ({
        decision: "deny_and_steer" as const,
        steer: "push to a feature branch instead",
      })),
      nextCorrelationId: () => "cid-e2e-1",
    })
    expect(await broker.escalate(req)).toEqual({
      approved: false,
      reason: "needs push",
      steer: "push to a feature branch instead",
    })
  })

  test("leader session-scoped allow survives the full wire", async () => {
    const broker = buildLeaderHitlBroker({
      workerId: "w",
      leaderId: "L",
      leaderDecide: buildLeaderDecide(async () => ({
        decision: "allow" as const,
        scope: "session" as const,
      })),
      nextCorrelationId: () => "cid-e2e-2",
    })
    expect(await broker.escalate(req)).toEqual({ approved: true, scope: "session" })
  })
})

// ── gate integration: the broker deny's steer reaches DispatchResult ──────────

describe("HELLGATE WS-A — a broker deny WITH steer surfaces steerInjection at the gate", () => {
  const softDeny = async (broker: GateEscalationBroker) => {
    const c = cfg({ registry: new ToolRegistry([write]), permission: { mode: "auto" } })
    return runAdmissibilityGate(
      call("write", {}),
      c,
      { mode: "auto" },
      actionOf(write, {}),
      denyClassifier("classifier blocked"),
      { coordinationBroker: broker },
    )
  }

  test("leader deny_and_steer ⇒ denied AND DispatchResult.steerInjection carries the steer", async () => {
    const broker: GateEscalationBroker = {
      escalate: async () => ({
        approved: false,
        reason: "leader said no",
        steer: "ask the leader to run it via the sanctioned script",
      }),
    }
    const res = await softDeny(broker)
    expect(res).not.toBeNull()
    expect(res?.steerInjection).toContain("sanctioned script")
    expect(res?.preview).toBe("deny_steer")
  })

  test("leader plain deny (no steer) ⇒ byte-identical legacy deny (no steerInjection)", async () => {
    const broker: GateEscalationBroker = {
      escalate: async () => ({ approved: false, reason: "leader said no" }),
    }
    const res = await softDeny(broker)
    expect(res).not.toBeNull()
    expect(res?.block.content).toContain("Permission denied")
    expect(res?.steerInjection).toBeUndefined()
  })

  test("leader approve ⇒ admitted (null) — the rich shape does not break the allow arm", async () => {
    const broker: GateEscalationBroker = {
      escalate: async () => ({ approved: true, scope: "session" as const }),
    }
    const res = await softDeny(broker)
    expect(res).toBeNull()
  })
})
