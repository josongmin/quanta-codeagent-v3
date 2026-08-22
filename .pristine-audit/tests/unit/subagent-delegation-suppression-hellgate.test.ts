/**
 * HELLGATE — C5059-05: single-agent-first delegation policy.
 *
 * INVARIANTS:
 *  1. Default-OFF is BYTE-IDENTICAL — no policy bytes leak into any prompt when
 *     `QUANTA_SUBAGENT_DELEGATE_SUPPRESS` is unset. (Rollout: opt-in measurement
 *     arm first.)
 *  2. When enabled, the policy appears EXACTLY ONCE and LEADS the description,
 *     assembled as `policy + "\n\n" + base` (exact — catches a changed separator).
 *  3. Every spawn surface projects the SAME SSOT atom — no paraphrase, no drift.
 *     OFF descriptions EQUAL their frozen originals (catches extraction drift).
 *  4. The knob is resolved from runtimeConfig (registered), default-OFF.
 *
 * MUTATION (red-on-injection): a call site that hard-codes its own suppression
 * sentence (invariant 3), appends on the OFF path (invariant 1), corrupts the
 * base during extraction (frozen-literal pin), or a wrong separator (exact
 * assembly) — each is caught here.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  DELEGATION_SUPPRESSION_POLICY,
  delegationSuppressEnabled,
  withDelegationPolicy,
} from "@/shared/delegation-policy"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import { createAgentTool, type SubagentRunner, TaskRegistry } from "@/subagent"
import { agentToolDescription } from "@/subagent/agent-tool"

const KNOB = "QUANTA_SUBAGENT_DELEGATE_SUPPRESS"

/** Set the knob and force runtimeConfig to re-read env. */
const setSuppress = (on: boolean): void => {
  if (on) process.env[KNOB] = "1"
  else delete process.env[KNOB]
  __resetRuntimeConfig()
}

afterEach(() => {
  delete process.env[KNOB]
  __resetRuntimeConfig()
})

describe("C5059-05 — delegation suppression policy (pure)", () => {
  test("OFF ⇒ description is byte-identical (no policy bytes)", () => {
    const base = "Spawn a child. Fan out several workers."
    expect(withDelegationPolicy(base, false)).toBe(base)
    expect(withDelegationPolicy(base, false)).not.toContain("DELEGATION POLICY")
  })

  test("ON ⇒ EXACT assembly (policy + double-newline + base), policy once", () => {
    const base = "Spawn a child."
    expect(withDelegationPolicy(base, true)).toBe(`${DELEGATION_SUPPRESSION_POLICY}\n\n${base}`)
    expect(withDelegationPolicy(base, true).split("DELEGATION POLICY:").length - 1).toBe(1)
  })

  test("policy gates on EXPLICIT authorization, not depth/thoroughness", () => {
    expect(DELEGATION_SUPPRESSION_POLICY).toContain("EXPLICITLY")
    expect(DELEGATION_SUPPRESSION_POLICY).toContain("NOT authorization")
    expect(DELEGATION_SUPPRESSION_POLICY.toLowerCase()).toContain("single")
  })

  test("policy pins the specific anti-gaming carve-out enumeration", () => {
    // The whole POINT of the policy is that 'I need depth/research' is NOT
    // authorization. A mutation collapsing the enumeration to a generic 'such
    // requests are NOT authorization' would survive the test above — pin the
    // concrete triggers AND their adjacency to 'NOT authorization'.
    const p = DELEGATION_SUPPRESSION_POLICY.toLowerCase()
    for (const trigger of ["depth", "research", "investigation", "thoroughness", "analysis"]) {
      expect(p, trigger).toContain(trigger)
    }
    expect(DELEGATION_SUPPRESSION_POLICY).toMatch(
      /depth, research, investigation, thoroughness,[^.]*NOT authorization/,
    )
  })

  test("dual-resolution: runtimeConfig and delegationSuppressEnabled AGREE for every env", () => {
    // The knob is resolved TWO ways (runtimeConfig().subagentDelegateSuppress for
    // the reminder path; delegationSuppressEnabled(env) for tool descriptions +
    // prompt body). Narrowing ONE would silently split the two prompt surfaces.
    for (const v of ["1", "on", "true", "yes", "TRUE", "0", "off", "false", "no", "garbage"]) {
      process.env[KNOB] = v
      __resetRuntimeConfig()
      expect(runtimeConfig().subagentDelegateSuppress, `env=${v}`).toBe(
        delegationSuppressEnabled({ [KNOB]: v }),
      )
    }
    delete process.env[KNOB]
    __resetRuntimeConfig()
    expect(runtimeConfig().subagentDelegateSuppress).toBe(delegationSuppressEnabled({}))
  })

  test("delegationSuppressEnabled pins the FULL gateOn vocab (not just '1')", () => {
    // The consumers call THIS (not runtimeConfig) — narrowing it to `=== "1"`
    // would silently break on/true/yes users and every other test stays green.
    // Pure env-map arg ⇒ zero process.env leakage.
    for (const on of ["1", "on", "true", "yes", "TRUE", "On", "  1  ", "Yes"]) {
      expect(delegationSuppressEnabled({ [KNOB]: on }), on).toBe(true)
    }
    for (const off of ["0", "off", "false", "no", "", "garbage", undefined]) {
      expect(delegationSuppressEnabled({ [KNOB]: off }), String(off)).toBe(false)
    }
  })

  test("knob resolves through runtimeConfig, default-OFF, only '1' enables", () => {
    setSuppress(false)
    expect(runtimeConfig().subagentDelegateSuppress).toBe(false)
    setSuppress(true)
    expect(runtimeConfig().subagentDelegateSuppress).toBe(true)
    process.env[KNOB] = "true"
    __resetRuntimeConfig()
    expect(runtimeConfig().subagentDelegateSuppress).toBe(true) // gateOn accepts 1/on/true/yes
  })
})

describe("C5059-05 — ALL spawn surfaces project the SSOT atom (no drift)", () => {
  // Frozen originals (verified byte-identical to HEAD's inline descriptions).
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
  // NOTE: `spawn_batch` / `spawn_agents_on_csv` are deliberately NOT gated — their
  // fan-out IS the tool's literal purpose (bulk "do X for each of N"), not a
  // general-analysis delegation bias, AND `@/tool/subagent-batch/batch.ts` sits in
  // a latent features.ts import cycle that ANY added import exposes. The confound
  // is fully addressed by the two general spawn tools + the system-prompt line.
  const surfaces = async () => {
    const { agentToolDescription } = await import("@/subagent/agent-tool")
    const { spawnAgent6Description } = await import("@/subagent/agent-tools-6")
    return [
      { render: agentToolDescription, orig: AGENT_ORIG },
      { render: spawnAgent6Description, orig: SPAWN6_ORIG },
    ]
  }

  test("ON ⇒ both general spawn surfaces lead with the identical SSOT policy", async () => {
    setSuppress(true)
    for (const s of await surfaces()) {
      expect(s.render().startsWith(DELEGATION_SUPPRESSION_POLICY), s.orig.slice(0, 24)).toBe(true)
      expect(s.render().split("DELEGATION POLICY:").length - 1).toBe(1)
    }
  })

  test("ON ⇒ both surfaces EQUAL exactly policy + \\n\\n + frozen base (no ON-path drift)", async () => {
    // startsWith + count let a base corrupted ONLY on the ON path (or trailing
    // garbage after the base) survive. Exact-assembly `.toBe` makes ON as strong
    // as the OFF frozen-literal pin.
    setSuppress(true)
    for (const s of await surfaces()) {
      expect(s.render(), s.orig.slice(0, 24)).toBe(`${DELEGATION_SUPPRESSION_POLICY}\n\n${s.orig}`)
    }
  })

  test("OFF ⇒ both surfaces EQUAL frozen originals (no leak, no extraction drift)", async () => {
    setSuppress(false)
    for (const s of await surfaces()) {
      expect(s.render(), s.orig.slice(0, 24)).toBe(s.orig)
    }
  })

  test("WIRING: the CONSTRUCTED agent tool's .description IS the gated function", () => {
    // The `surfaces` tests call the description functions standalone. This pins
    // the REAL construction path: createAgentTool must feed agentToolDescription()
    // into tool.description. A refactor that hard-codes the base string (bypassing
    // the gate) would keep the standalone tests green but fail here — ON and OFF.
    const runner: SubagentRunner = async () => ({ ok: true, finalText: "", turns: 1 })
    for (const on of [true, false]) {
      setSuppress(on)
      const tool = createAgentTool({ runner, registry: new TaskRegistry() })
      expect(tool.description).toBe(agentToolDescription())
      expect(tool.description.startsWith(DELEGATION_SUPPRESSION_POLICY)).toBe(on)
    }
  })
})
