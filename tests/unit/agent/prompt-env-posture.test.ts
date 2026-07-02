import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent/prompt"

/**
 * Lever #1 (RFC jul-2-terminal-bench-levers/01) — `envPosture` opt on buildSystemPrompt.
 *
 * HARD invariant: `frozen` / absent is byte-identical to today (the cached system-prompt
 * prefix must not shift for any existing caller). `owned` swaps ONLY the env-rule TEXT.
 */
describe("buildSystemPrompt — envPosture (RFC jul-2)", () => {
  test("absent envPosture and envPosture:'frozen' are BYTE-IDENTICAL (default byte-stable)", () => {
    const absent = buildSystemPrompt()
    const frozen = buildSystemPrompt(undefined, { envPosture: "frozen" })
    expect(frozen).toBe(absent)
  })

  test("frozen prompt STILL carries the SWE-bench install-prohibition rules (unchanged)", () => {
    const frozen = buildSystemPrompt()
    expect(frozen).toContain("[R-ENV]")
    expect(frozen).toContain("[R-STOP-ENV]")
    expect(frozen).toContain("Do NOT attempt to install dependencies")
  })

  test("owned prompt DROPS R-ENV / R-STOP-ENV and ADDS R-ENV-OWNED / R-INSTALL-THRASH", () => {
    const owned = buildSystemPrompt(undefined, { envPosture: "owned" })
    expect(owned).not.toContain("[R-ENV]")
    expect(owned).not.toContain("[R-STOP-ENV]")
    expect(owned).not.toContain("Do NOT attempt to install dependencies")
    expect(owned).toContain("[R-ENV-OWNED]")
    expect(owned).toContain("[R-INSTALL-THRASH]")
    expect(owned).toContain("You own this environment")
  })

  test("owned differs from frozen ONLY by swapping the env-rule block (intro/persona/body intact)", () => {
    const frozen = buildSystemPrompt()
    const owned = buildSystemPrompt(undefined, { envPosture: "owned" })
    expect(owned).not.toBe(frozen)
    // The shared universal rails survive the swap.
    for (const id of ["[R-SEARCH-FIRST]", "[R-READ-FAILURE]", "[R-NO-THRASH]", "[R-FAILURE-MODE]"]) {
      expect(frozen).toContain(id)
      expect(owned).toContain(id)
    }
  })

  test("persona still applies under owned posture (posture is orthogonal to persona)", () => {
    const ownedDefault = buildSystemPrompt(undefined, { envPosture: "owned", persona: "default" })
    const ownedFriendly = buildSystemPrompt(undefined, { envPosture: "owned", persona: "friendly" })
    // A non-default persona changes the prompt; both keep the owned env rule.
    expect(ownedFriendly).not.toBe(ownedDefault)
    expect(ownedFriendly).toContain("[R-ENV-OWNED]")
  })
})
