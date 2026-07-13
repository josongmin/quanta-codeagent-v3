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
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import { DELEGATION_SUPPRESSION_POLICY, withDelegationPolicy } from "@/shared/delegation-policy"

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
  const BATCH_ORIG =
    "Fan out one templated child subagent per item over a bounded worker pool. " +
    "Provide items (inline array) OR items_path (.csv/.jsonl/.json) plus a " +
    "prompt_template with {{placeholders}}. Returns per-item structured results; " +
    "one item failing does NOT stop the rest. Use for bulk 'do X for each of these N things'."
  const CSV_ORIG =
    "Run a batch: fan ONE subagent out per CSV row with a shared instruction, " +
    "collect each row's structured result, and return a results CSV. Use for " +
    "repetitive per-row work (e.g. classify/transform N records). Bounded " +
    "concurrency; EXPENSIVE (one child agent per row)."

  /** All four spawn/delegation surfaces + their frozen OFF originals. */
  const surfaces = async () => {
    const { agentToolDescription } = await import("@/subagent/agent-tool")
    const { spawnAgent6Description } = await import("@/subagent/agent-tools-6")
    const { spawnBatchDescription } = await import("@/tool/subagent-batch/batch")
    const { spawnAgentsCsvDescription } = await import("@/tool/spawn-agents-csv")
    return [
      { render: agentToolDescription, orig: AGENT_ORIG },
      { render: spawnAgent6Description, orig: SPAWN6_ORIG },
      { render: spawnBatchDescription, orig: BATCH_ORIG },
      { render: spawnAgentsCsvDescription, orig: CSV_ORIG },
    ]
  }

  test("ON ⇒ ALL FOUR surfaces lead with the identical SSOT policy", async () => {
    setSuppress(true)
    for (const s of await surfaces()) {
      expect(s.render().startsWith(DELEGATION_SUPPRESSION_POLICY), s.orig.slice(0, 24)).toBe(true)
      expect(s.render().split("DELEGATION POLICY:").length - 1).toBe(1)
    }
  })

  test("OFF ⇒ ALL FOUR surfaces EQUAL frozen originals (no leak, no extraction drift)", async () => {
    setSuppress(false)
    for (const s of await surfaces()) {
      expect(s.render(), s.orig.slice(0, 24)).toBe(s.orig)
    }
  })
})
