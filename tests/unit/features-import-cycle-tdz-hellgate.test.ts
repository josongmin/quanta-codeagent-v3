import { describe, expect, test } from "bun:test"

/**
 * Regression pin for the `@/agent/features` import-cycle TDZ crash.
 *
 * `SESSION_FEATURE_BLOCKS` in `src/agent/features.ts` is a data table of
 * `(config) => Tool[]` builders. `@/agent/features` sits in an import cycle
 * (the `@/tool` + `@/subagent` + `@/agent/tier1` graph re-enters it), so if an
 * entry is a BARE reference to a `tier1` `export const` builder (e.g.
 * `buildShadowBlock,`), that symbol is read at ARRAY-CONSTRUCTION time — during
 * this module's own init, while the referenced builder can still be in its
 * temporal dead zone. That threw:
 *   ReferenceError: Cannot access 'buildShadowBlock' before initialization
 * under the import order that pulls `@/tool` / `@/subagent` FIRST (as the
 * tool-surface manifest hellgate does). Every entry is now an arrow
 * `(c) => buildX(c)` so the symbol read is deferred to CALL time.
 *
 * This test reproduces the crash-triggering order: import the sibling barrels
 * FIRST, THEN `@/agent/features`. RED-ON-INJECTION: revert any entry back to a
 * bare `buildX` ref and this import throws the TDZ ReferenceError ⇒ RED.
 */
describe("features.ts import-cycle TDZ (hellgate)", () => {
  test("the manifest-hellgate import order evaluates @/agent/features without a TDZ ReferenceError", async () => {
    // This is the EXACT barrel order the tool-surface manifest hellgate pulls
    // (`@/agent/objective` FIRST, before `@/agent/tier1`), which re-enters
    // `@/agent/features` while `@/agent/tier1` is still initializing — the
    // condition that surfaced the bare-ref TDZ. Under a bare `buildShadowBlock,`
    // entry this import graph throws `Cannot access 'buildShadowBlock' before
    // initialization`; with the arrow-wrapped entries it loads clean.
    await import("@/agent/objective")
    await import("@/agent/subagent-mailbox")
    await import("@/agent/tier1")
    await import("@/subagent")
    const mod = await import("@/agent/features")
    // Loaded past the `SESSION_FEATURE_BLOCKS` literal without a ReferenceError,
    // and the public builder is present + callable-typed.
    expect(typeof mod.buildSessionFeatures).toBe("function")
  })
})
