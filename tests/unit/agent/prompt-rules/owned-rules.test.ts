import { describe, expect, test } from "bun:test"
import { CORE_RULES, OWNED_RULES, renderOwnedRules } from "@/agent/prompt-rules"

/**
 * Lever #1 (RFC jul-2-terminal-bench-levers/01) — the `owned` environment posture
 * rule list. Structural invariants that pin the posture's contract:
 *
 *   1. OMITS the frozen install-prohibition rules (R-ENV, R-STOP-ENV).
 *   2. CONTAINS the two new owned rules (R-ENV-OWNED, R-INSTALL-THRASH).
 *   3. KEEPS the four universal honesty/search rails (R-SEARCH-FIRST, R-READ-FAILURE,
 *      R-NO-THRASH, R-FAILURE-MODE) — and REUSES the exact CORE_RULES objects (no drift).
 *   4. KEEPS the R-NO-SHIM shim-ban CORE, but DROPS its "declare the environment
 *      unavailable and stop" frozen tail (the owned box installs the dep instead).
 *   5. renderOwnedRules() is a byte-faithful flatten of OWNED_RULES' lines.
 */

const idOf = (r: { readonly id: string }): string => r.id
const OWNED_IDS = OWNED_RULES.map(idOf)

describe("OWNED_RULES — env posture rule list", () => {
  test("OMITS the frozen install-prohibition rules R-ENV / R-STOP-ENV", () => {
    expect(OWNED_IDS).not.toContain("R-ENV")
    expect(OWNED_IDS).not.toContain("R-STOP-ENV")
    const joined = renderOwnedRules().join("\n")
    expect(joined).not.toContain("[R-ENV]")
    expect(joined).not.toContain("[R-STOP-ENV]")
  })

  test("CONTAINS the two new owned rules R-ENV-OWNED / R-INSTALL-THRASH", () => {
    expect(OWNED_IDS).toContain("R-ENV-OWNED")
    expect(OWNED_IDS).toContain("R-INSTALL-THRASH")
    const joined = renderOwnedRules().join("\n")
    expect(joined).toContain("[R-ENV-OWNED]")
    expect(joined).toContain("[R-INSTALL-THRASH]")
    // R-ENV-OWNED carries the install-permitted intent (the model is TOLD it may install).
    expect(joined).toContain("You own this environment")
    expect(joined).toContain("A working")
    expect(joined.toLowerCase()).toContain("install dependencies")
  })

  test("KEEPS the four universal rails, REUSING the exact CORE_RULES objects (no drift)", () => {
    for (const id of ["R-SEARCH-FIRST", "R-READ-FAILURE", "R-NO-THRASH", "R-FAILURE-MODE"]) {
      expect(OWNED_IDS).toContain(id)
      const coreObj = CORE_RULES.find((r) => r.id === id)
      const ownedObj = OWNED_RULES.find((r) => r.id === id)
      // Same object reference ⇒ a wording change to a shared rule updates BOTH lists at once.
      expect(ownedObj).toBe(coreObj)
    }
  })

  test("KEEPS R-NO-SHIM's shim-ban CORE but DROPS the frozen stop-tail", () => {
    expect(OWNED_IDS).toContain("R-NO-SHIM")
    const joined = renderOwnedRules().join("\n")
    // shim-ban core stays…
    expect(joined).toContain("Do NOT create stub/mock/shim files")
    // …but the frozen "declare the environment unavailable and stop" tail is gone.
    expect(joined).not.toContain("declare the")
    expect(joined.toLowerCase()).not.toContain("environment unavailable")
    // And this owned variant is a DIFFERENT object than the frozen R-NO-SHIM (text diverged).
    const frozenShim = CORE_RULES.find((r) => r.id === "R-NO-SHIM")
    const ownedShim = OWNED_RULES.find((r) => r.id === "R-NO-SHIM")
    expect(ownedShim).not.toBe(frozenShim)
  })

  test("renderOwnedRules() is a byte-faithful flatten of OWNED_RULES lines", () => {
    expect(renderOwnedRules()).toEqual(OWNED_RULES.flatMap((r) => r.lines))
  })

  test("every owned rule ID appears exactly once in the rendered block", () => {
    const joined = renderOwnedRules().join("\n")
    for (const id of OWNED_IDS) {
      const count = joined.split(`[${id}]`).length - 1
      expect(count).toBe(1)
    }
  })

  // jul-9 audit S2/S3: the prior guards were all `.toContain` — R-ENV-DONE and the owned
  // R-NO-SHIM body were never pinned, and the two-axis parity anchor is self-referential
  // (recomputes from OWNED_RULES), so a rule could be silently dropped/reordered with zero
  // failing test. Pin the EXACT roster + order as the owned-axis content anchor.
  test("EXACT owned roster + order (catches silent add/drop/reorder — the owned-axis anchor)", () => {
    expect(OWNED_IDS).toEqual([
      "R-SEARCH-FIRST",
      "R-READ-FAILURE",
      "R-NO-THRASH",
      "R-FAILURE-MODE",
      "R-NO-SHIM",
      "R-ENV-OWNED",
      "R-INSTALL-THRASH",
      "R-ENV-DONE",
    ])
  })

  test("R-ENV-DONE (completion-stop rail) present with its stop-when-clean contract", () => {
    expect(OWNED_IDS).toContain("R-ENV-DONE")
    const joined = renderOwnedRules().join("\n")
    expect(joined).toContain("[R-ENV-DONE]")
    // distinctive contract: env-config is a MEANS; STOP once the verifying command exits clean.
    expect(joined).toContain("Configuring the environment is a MEANS")
    expect(joined).toContain("exits clean")
  })

  test("owned R-NO-SHIM body keeps its install-the-real-dep tail (owned variant, not frozen)", () => {
    const joined = renderOwnedRules().join("\n")
    // the owned variant swaps the frozen stop-tail for "install/configure the real dependency"
    expect(joined).toContain("install/configure the real")
  })
})
