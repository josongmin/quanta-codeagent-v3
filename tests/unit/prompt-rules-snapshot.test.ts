import { describe, expect, test } from "bun:test"
// Direct module import (not @/agent barrel) so this test stays runnable when
// sibling modules in the agent package are unrelated WIP — T5a only touches
// prompt.ts and only asserts on the static system prompt content.
import { buildSystemPrompt } from "@/agent/prompt"

/**
 * T5a anti-regression: the R-ENV / R-STOP-ENV rules added to address Bench
 * Type-F (agent burning 17 turns on `pip install` retries) MUST stay in the
 * static system prompt verbatim. The dispatch dedup gate is the structural
 * backstop; these prompt rules are the model-obedient short-circuit. If the
 * rule IDs or key phrases drift, the prompt-level signal disappears and we
 * lose the cheap fix.
 */
describe("system prompt — T5a env-mod / stop-when-blocked rules", () => {
  const prompt = buildSystemPrompt()
  const lower = prompt.toLowerCase()

  test("rule IDs [R-ENV] and [R-STOP-ENV] appear inline", () => {
    expect(prompt).toContain("[R-ENV]")
    expect(prompt).toContain("[R-STOP-ENV]")
  })

  test("R-ENV pins the install-prohibition phrasing", () => {
    // The specific verb pattern bench parses against; rewording it loses the
    // model-obedient match in tracked failure cases.
    expect(prompt).toContain("Do NOT attempt to install dependencies")
    expect(lower).toContain("your patch is the deliverable")
  })

  test("R-ENV names the canonical env-modifying commands", () => {
    // Each of these has triggered a Type-F loop in production traces. Naming
    // them explicitly is what makes the rule actionable rather than aspirational.
    expect(prompt).toContain("`pip`")
    expect(prompt).toContain("`npm`")
    expect(prompt).toContain("`apt`")
    expect(prompt).toContain("`brew`")
    expect(prompt).toContain("`sudo`")
  })

  test("R-STOP-ENV pins the stop-on-env-block phrasing", () => {
    expect(prompt).toContain("[R-STOP-ENV]")
    expect(prompt).toContain("STOP")
    // The structural insight: tactic-switching is code-change, not retry.
    expect(lower).toContain("repeating the same install or env command")
    expect(lower).toContain("changing the code, not retrying the command")
  })

  test("each rule appears EXACTLY once (no duplicate injection)", () => {
    // Defends against accidental re-injection from a future absorption pass.
    const renvCount = prompt.split("[R-ENV]").length - 1
    const rstopCount = prompt.split("[R-STOP-ENV]").length - 1
    expect(renvCount).toBe(1)
    expect(rstopCount).toBe(1)
  })

  test("cache-prefix invariance — buildSystemPrompt() is byte-stable across calls", () => {
    // ADR-0003/0004: the static prefix MUST be byte-identical so the provider
    // prompt-cache prefix holds across the whole session. Adding rules is fine
    // as long as they are deterministic + position-stable.
    const a = buildSystemPrompt()
    const b = buildSystemPrompt()
    expect(a).toBe(b)
    expect(a.length).toBe(b.length)
  })

  test("rules land between Tool routing and Honesty rail (not in dynamic block)", () => {
    // Placement guard: the rules MUST be in the static prefix (which is what
    // buildSystemPrompt returns), not in buildTurnContext's per-turn block.
    // Asserting their position between two stable section headers proves they
    // ride the cached prefix.
    const toolRoutingIdx = prompt.indexOf("Tool routing")
    const renvIdx = prompt.indexOf("[R-ENV]")
    const rstopIdx = prompt.indexOf("[R-STOP-ENV]")
    const honestyIdx = prompt.indexOf("Honesty rail")
    expect(toolRoutingIdx).toBeGreaterThanOrEqual(0)
    expect(renvIdx).toBeGreaterThan(toolRoutingIdx)
    expect(rstopIdx).toBeGreaterThan(renvIdx)
    expect(honestyIdx).toBeGreaterThan(rstopIdx)
  })
})
