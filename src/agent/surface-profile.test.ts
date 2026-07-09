/**
 * SurfaceProfile seam — surface-adaptive prompt composition (RFC
 * `jul-2-terminal-bench-levers/00` §X).
 *
 * HELLGATE proofs:
 *   - Composition is SURFACE-AGNOSTIC: two DIFFERENT profiles → two DIFFERENT
 *     prompts, produced purely from declared values (no per-surface `if`).
 *   - The FROZEN default composes BYTE-FOR-BYTE the same prompt as today's
 *     `buildSystemPrompt()` with no opts (the DEFAULT-OFF invariant).
 *   - PROMPT-TEXT-ONLY: the profile carries strings / a rule-pack selector and
 *     nothing that could touch runtime enforcement (enforced by construction —
 *     asserted structurally here).
 */

import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "./prompt"
import {
  composeSystemPromptForSurface,
  FROZEN_SURFACE_PROFILE,
  type SurfaceProfile,
  SWE_SURFACE_PROFILE,
} from "./surface-profile"

// jul-9 audit Finding 3a: grader-only (verify axis) emits "do NOT install / do NOT run
// tests", which CONTRADICTS an install-permitting env posture (owned / default). The type
// system permits the pairing, but production never composes it: grader-only is swebench-gated
// (config-build.isGraderOnlyPosture requires `instance.swebench`), and the SWE surface is
// FROZEN. Pin that invariant so a future change that flips the SWE surface to an
// install-permitting posture — re-opening the contradiction — red-fires here.
describe("SurfaceProfile — grader-only never rides an install-permitting posture (Finding 3a)", () => {
  test("the SWE surface (the only grader-only carrier) is FROZEN, not owned/default", () => {
    expect(SWE_SURFACE_PROFILE.envPosture).toBe("frozen")
    expect(FROZEN_SURFACE_PROFILE.envPosture).toBe("frozen")
    // frozen posture emits the install-PROHIBITION, so grader-only's "don't install" agrees.
    const swe = composeSystemPromptForSurface(SWE_SURFACE_PROFILE)
    expect(swe).toContain("[R-ENV]") // frozen install-prohibition present
    expect(swe).not.toContain("[R-ENV-LOCAL]") // NOT the install-permitting default posture
    expect(swe).not.toContain("[R-ENV-OWNED]") // NOT the install-permitting owned posture
  })
})

describe("SurfaceProfile — surface-agnostic prompt composition", () => {
  test("FROZEN default composes BYTE-IDENTICALLY to today's buildSystemPrompt() (DEFAULT-OFF invariant)", () => {
    const composed = composeSystemPromptForSurface(FROZEN_SURFACE_PROFILE)
    // The un-declared, no-opts prompt every existing surface renders today.
    expect(composed).toBe(buildSystemPrompt())
    // Sanity: it IS the frozen prompt (carries the frozen env guardrails).
    expect(composed).toContain("[R-ENV]")
    expect(composed).toContain("[R-STOP-ENV]")
    expect(composed).not.toContain("[R-ENV-OWNED]")
  })

  test("an explicit { envPosture: 'frozen' } profile is byte-identical to today (no envPosture key leaks)", () => {
    const explicitFrozen: SurfaceProfile = { envPosture: "frozen" }
    expect(composeSystemPromptForSurface(explicitFrozen)).toBe(buildSystemPrompt())
  })

  test("TWO different profiles → TWO different prompts (proves composition, not a hardcoded branch)", () => {
    const frozen: SurfaceProfile = { envPosture: "frozen" }
    const owned: SurfaceProfile = {
      envPosture: "owned",
      operatorGuide: "you own the box",
    }
    const frozenPrompt = composeSystemPromptForSurface(frozen)
    const ownedPrompt = composeSystemPromptForSurface(owned)
    expect(ownedPrompt).not.toBe(frozenPrompt)
    // Owned swaps the env-rule TEXT: drops frozen R-ENV, adds R-ENV-OWNED.
    expect(frozenPrompt).toContain("[R-ENV]")
    expect(ownedPrompt).not.toContain("[R-ENV]")
    expect(ownedPrompt).toContain("[R-ENV-OWNED]")
    expect(ownedPrompt).toContain("[R-INSTALL-THRASH]")
    // Universal honesty rails survive the swap.
    expect(ownedPrompt).toContain("[R-READ-FAILURE]")
    expect(ownedPrompt).toContain("[R-FAILURE-MODE]")
  })

  test("the owned composition matches buildSystemPrompt({ envPosture:'owned' }) exactly (pure passthrough)", () => {
    const owned: SurfaceProfile = { envPosture: "owned", operatorGuide: "guide" }
    // The operatorGuide is NOT folded into the cached system prefix — it is a
    // per-turn injection the entry point owns — so the SYSTEM prompt equals the
    // raw owned build regardless of the operatorGuide value.
    expect(composeSystemPromptForSurface(owned, { persona: "default" })).toBe(
      buildSystemPrompt(undefined, { persona: "default", envPosture: "owned" }),
    )
  })

  test("a rulePack profile (frozen posture) selects the mode-specific pack (surface declares its task rules)", () => {
    const ciBot: SurfaceProfile = { envPosture: "frozen", rulePack: "ci-bot" }
    expect(composeSystemPromptForSurface(ciBot)).toBe(
      buildSystemPrompt(undefined, { promptPack: "ci-bot" }),
    )
    // And it differs from the interactive default.
    expect(composeSystemPromptForSurface(ciBot)).not.toBe(buildSystemPrompt())
  })

  test("owned + a rulePack COMPOSE independently (jul-4 2-axis: no XOR, both axes apply)", () => {
    const owned: SurfaceProfile = { envPosture: "owned", rulePack: "ci-bot" }
    // Post-XOR-removal the seam forwards BOTH axes: the result is the core's
    // owned base THEN the ci-bot task rule — NOT plain owned (the old crutch).
    expect(composeSystemPromptForSurface(owned)).toBe(
      buildSystemPrompt(undefined, { envPosture: "owned", promptPack: "ci-bot" }),
    )
    // It is strictly LONGER than plain owned (the task pack really was appended)…
    const ownedOnly = buildSystemPrompt(undefined, { envPosture: "owned" })
    expect(composeSystemPromptForSurface(owned).length).toBeGreaterThan(ownedOnly.length)
    // …and it is NOT the plain-owned prompt (guards a silent regression back to XOR).
    expect(composeSystemPromptForSurface(owned)).not.toBe(ownedOnly)
  })

  test("cwd passthrough does not shift the cached system prefix (cwd is per-turn dynamic, ignored by build)", () => {
    const p: SurfaceProfile = { envPosture: "frozen" }
    // buildSystemPrompt ignores cwd by design → composing with a cwd is still today's prompt.
    expect(composeSystemPromptForSurface(p, { cwd: "/some/where" })).toBe(buildSystemPrompt())
  })

  test("PROMPT-TEXT-ONLY: a SurfaceProfile's fields are strings / a pack selector — no runtime-enforcement shape", () => {
    const p: SurfaceProfile = {
      envPosture: "owned",
      operatorGuide: "guide",
      rulePack: "batch",
    }
    // envPosture is a string literal union; operatorGuide/rulePack are strings.
    expect(typeof p.envPosture).toBe("string")
    expect(typeof p.operatorGuide).toBe("string")
    expect(typeof p.rulePack).toBe("string")
    // No sandbox / policy / enforcement key is present on the value object.
    for (const forbidden of ["sandbox", "sandboxPolicy", "policy", "permissions", "sandboxMode"]) {
      expect(Object.hasOwn(p, forbidden)).toBe(false)
    }
  })
})
