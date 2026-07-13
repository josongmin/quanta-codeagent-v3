/**
 * Wiring-proof (jul-13 prompt design-system) — proves the shared primitives are
 * LOAD-BEARING on the real render path, not just present in the tree.
 *
 * The refactor is byte-identical, so a naive "render == literal" test cannot tell
 * a WIRED primitive from a coincidental hard-coded duplicate. Each test below
 * closes that gap a different way:
 *   - INTRO: paired control (render carries ROLE.principal, NOT ROLE.senior) +
 *     the role-drift ratchet (the phrase exists ONLY in shared.ts) ⇒ by
 *     elimination the render must SOURCE the phrase from the primitive.
 *   - registry↔identity: REFERENTIAL equality (same frozen array object) proves
 *     the mode-variant table is a projection of the identity SSOT, not a copy.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_IDENTITIES } from "../identity"
import { buildSystemPrompt } from "../prompt"
import { DEFAULT_MODE_VARIANTS } from "../system-prompt"
import { MODE_VARIANT_KEYS } from "../system-prompt/port"
import { AGENT_NAME, agentOpener, ROLE } from "./shared"

describe("role-wiring — shared primitives are load-bearing on the render path", () => {
  test("INTRO first line IS agentOpener(principal) — and specifically principal, not senior", () => {
    const firstLine = buildSystemPrompt().split("\n")[0]
    const tail = "working autonomously in a"
    // Positive: the live render equals the primitive's current output.
    expect(firstLine).toBe(agentOpener({ name: AGENT_NAME, role: ROLE.principal, tail }))
    // Paired control: it carries ROLE.principal SPECIFICALLY — swapping the role
    // token changes the line, so the value genuinely flows through (not "any opener").
    expect(firstLine).not.toBe(agentOpener({ name: AGENT_NAME, role: ROLE.senior, tail }))
    // The primitive itself is non-trivial: it embeds both centralized tokens.
    expect(firstLine).toContain(AGENT_NAME)
    expect(firstLine).toContain(ROLE.principal)
  })

  test("mode-variant table is a PROJECTION of the identity SSOT (referential, not copied)", () => {
    for (const mode of MODE_VARIANT_KEYS) {
      // Same frozen array OBJECT — mutating the identity source would move this
      // in lock-step. A copied literal would fail `toBe` (reference) while passing
      // `toEqual` (value); we assert the stronger reference identity.
      expect(DEFAULT_MODE_VARIANTS[mode]).toBe(DEFAULT_IDENTITIES[mode])
    }
  })

  test("every mode-variant key exists in the identity superset (ModeVariantKey ⊂ IdentityMode)", () => {
    for (const mode of MODE_VARIANT_KEYS) {
      expect(DEFAULT_IDENTITIES[mode]).toBeDefined()
      expect(DEFAULT_IDENTITIES[mode].length).toBeGreaterThan(0)
    }
  })
})
