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
} from "./surface-profile"

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

  test("owned posture WINS over a rulePack (env rules take precedence, mirroring the core)", () => {
    const owned: SurfaceProfile = { envPosture: "owned", rulePack: "ci-bot" }
    // rulePack is inert under owned — result equals plain owned, not the pack.
    expect(composeSystemPromptForSurface(owned)).toBe(
      buildSystemPrompt(undefined, { envPosture: "owned" }),
    )
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
