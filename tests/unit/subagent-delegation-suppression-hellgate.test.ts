/**
 * HELLGATE — C5059-05: single-agent-first delegation policy.
 *
 * INVARIANTS:
 *  1. Default-OFF is BYTE-IDENTICAL — no policy bytes leak into any prompt when
 *     the knob is unset (measurement-arm rollout: opt-in first).
 *  2. When enabled, the policy appears EXACTLY ONCE and LEADS the description.
 *  3. Both spawn surfaces (trio `agent` + 6-tool `spawn_agent`) project the SAME
 *     SSOT atom — no paraphrase, no drift (grep of the two descriptions must both
 *     contain the identical `DELEGATION_SUPPRESSION_POLICY`).
 *  4. The policy actually gates on EXPLICIT authorization (not depth/thoroughness).
 *
 * MUTATION (red-on-injection): a call site that hard-codes its own suppression
 * sentence instead of the SSOT atom (invariant 3), or that appends on the OFF
 * path (invariant 1), is caught here.
 */
import { describe, expect, test } from "bun:test"
import {
  DELEGATION_SUPPRESS_ENV,
  DELEGATION_SUPPRESSION_POLICY,
  delegationSuppressEnabled,
  withDelegationPolicy,
} from "@/subagent/delegation-policy"

describe("C5059-05 — delegation suppression policy (pure)", () => {
  test("OFF ⇒ description is byte-identical (no policy bytes)", () => {
    const base = "Spawn a child. Fan out several workers."
    expect(withDelegationPolicy(base, false)).toBe(base)
    expect(withDelegationPolicy(base, false)).not.toContain("DELEGATION POLICY")
  })

  test("ON ⇒ EXACT assembly (policy + double-newline + base), policy once", () => {
    const base = "Spawn a child."
    // Exact-assembly `.toBe` (not startsWith/endsWith): catches a changed
    // separator ("\n\n"→" "), reordering, or any middle-insertion.
    expect(withDelegationPolicy(base, true)).toBe(`${DELEGATION_SUPPRESSION_POLICY}\n\n${base}`)
    const marker = "DELEGATION POLICY:"
    expect(withDelegationPolicy(base, true).split(marker).length - 1).toBe(1)
  })

  test("policy gates on EXPLICIT authorization, not depth/thoroughness", () => {
    expect(DELEGATION_SUPPRESSION_POLICY).toContain("EXPLICITLY")
    expect(DELEGATION_SUPPRESSION_POLICY).toContain("NOT authorization")
    expect(DELEGATION_SUPPRESSION_POLICY.toLowerCase()).toContain("single")
  })

  test("knob reads default-OFF and only '1' enables", () => {
    expect(delegationSuppressEnabled({})).toBe(false)
    expect(delegationSuppressEnabled({ [DELEGATION_SUPPRESS_ENV]: "0" })).toBe(false)
    expect(delegationSuppressEnabled({ [DELEGATION_SUPPRESS_ENV]: "true" })).toBe(false)
    expect(delegationSuppressEnabled({ [DELEGATION_SUPPRESS_ENV]: "1" })).toBe(true)
  })
})

describe("C5059-05 — BOTH spawn surfaces project the SSOT atom (no drift)", () => {
  test("trio `agent` + 6-tool `spawn_agent` descriptions both carry the identical policy when enabled", async () => {
    // Wiring proof: build each tool's model-facing description with the knob ON
    // and assert BOTH begin with the exact same SSOT string. A hard-coded
    // per-surface paraphrase (drift) fails invariant 3.
    const prev = process.env[DELEGATION_SUPPRESS_ENV]
    process.env[DELEGATION_SUPPRESS_ENV] = "1"
    try {
      const { agentToolDescription } = await import("@/subagent/agent-tool")
      const { spawnAgent6Description } = await import("@/subagent/agent-tools-6")
      expect(agentToolDescription().startsWith(DELEGATION_SUPPRESSION_POLICY)).toBe(true)
      expect(spawnAgent6Description().startsWith(DELEGATION_SUPPRESSION_POLICY)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env[DELEGATION_SUPPRESS_ENV]
      else process.env[DELEGATION_SUPPRESS_ENV] = prev
    }
  })

  // Frozen originals (verified byte-identical to HEAD's inline descriptions).
  // Pinning OFF output to these `.toBe(...)` catches EXTRACTION DRIFT — a dropped
  // word in the base const during refactor stays green under `not.toContain`.
  const AGENT_ORIG =
    "Launch a subagent to autonomously handle ONE delegated task. " +
    "Foreground returns the subagent's summary; set background:true to get a " +
    "task id and poll with task_output / cancel with task_stop. " +
    "Pass continue_from to warm-start from a prior task's findings; pass checkpoint:true " +
    "(non-isolation only) to enable interim progress at .subagent-state/<task_id>.md. " +
    "For running MANY children concurrently or steering a child mid-run use " +
    "spawn_agent / wait_agent / send_input instead; for the SAME task over a list " +
    "of inputs use spawn_batch."
  const SPAWN6_ORIG =
    "Spawn a CONCURRENT child subagent, returning its agentId immediately. This " +
    "is the FAN-OUT / interactive primitive: launch several workers in parallel, " +
    "STEER a paused one mid-run with send_input, and collect them with " +
    "wait_agent / close_agent. For a SINGLE delegated task prefer the `agent` " +
    "tool (its background:true gives the same async handle with simpler " +
    "task_output polling); reach for spawn_agent when you need multiple " +
    "concurrent children or mid-run control."

  test("OFF ⇒ both surfaces EQUAL their frozen originals (no leak, no extraction drift)", async () => {
    const prev = process.env[DELEGATION_SUPPRESS_ENV]
    delete process.env[DELEGATION_SUPPRESS_ENV]
    try {
      const { agentToolDescription } = await import("@/subagent/agent-tool")
      const { spawnAgent6Description } = await import("@/subagent/agent-tools-6")
      expect(agentToolDescription()).toBe(AGENT_ORIG)
      expect(spawnAgent6Description()).toBe(SPAWN6_ORIG)
    } finally {
      if (prev !== undefined) process.env[DELEGATION_SUPPRESS_ENV] = prev
    }
  })
})
