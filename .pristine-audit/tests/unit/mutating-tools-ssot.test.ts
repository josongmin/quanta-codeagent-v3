/**
 * ★ RATCHET + CONTRACT (jun-28) — the FS-edit tool set is a SINGLE SSOT shared by
 * the localize-phase guard and the verify-guard finish gate, and verify-guard now
 * treats apply_patch/scripted_replace as mutating.
 *
 * The bug this closes: verify-guard's set was {edit,write} while localize-phase's
 * was the full 5-tool set. A model that fixed SOURCE via `apply_patch` then
 * declared "done" was never finish-gated (no presence/must-pass/sticky check),
 * because findLastMutating returned -1. The two sets had drifted.
 */

import { describe, expect, test } from "bun:test"
import { MUTATING_TOOL_NAMES } from "@/agent/localize-phase-guard"
import { MUTATING_FS_EDIT_TOOLS } from "@/agent/mutating-tools"
import { createVerifyGuardState, decideVerifyGuard } from "@/agent/verify-guard"

describe("mutating-tools SSOT", () => {
  test("the shared set covers all 5 FS-edit tools", () => {
    for (const t of [
      "edit",
      "write",
      "scripted_replace",
      "apply_patch",
      "apply_patch_structured",
    ]) {
      expect(MUTATING_FS_EDIT_TOOLS.has(t)).toBe(true)
    }
  })

  test("bash is NOT in the set (deliberate — verify/probe channel)", () => {
    expect(MUTATING_FS_EDIT_TOOLS.has("bash")).toBe(false)
  })

  test("localize-phase MUTATING_TOOL_NAMES IS the shared SSOT (no drift)", () => {
    expect(MUTATING_TOOL_NAMES).toBe(MUTATING_FS_EDIT_TOOLS)
  })
})

describe("HELLGATE — verify-guard treats apply_patch / scripted_replace as mutating", () => {
  const decide = (...history: Array<{ name: string; ok?: boolean }>) =>
    decideVerifyGuard({
      history,
      cfg: { mustPass: true, maxTrips: 2 },
      state: createVerifyGuardState(),
    })

  test("apply_patch then finish (no verify after) ⇒ BLOCK (presence branch fires)", () => {
    // RED before the fix: MUTATING={edit,write} ⇒ findLastMutating=-1 ⇒ no block.
    expect(decide({ name: "apply_patch" }).block).toBe(true)
  })

  test("scripted_replace then finish ⇒ BLOCK", () => {
    expect(decide({ name: "scripted_replace" }).block).toBe(true)
  })

  test("apply_patch_structured then finish ⇒ BLOCK", () => {
    expect(decide({ name: "apply_patch_structured" }).block).toBe(true)
  })

  test("apply_patch THEN a passing verify ⇒ no block (verified)", () => {
    expect(decide({ name: "apply_patch" }, { name: "test_runner", ok: true }).block).toBe(false)
  })

  test("a non-edit tool alone (read) ⇒ no block (nothing to verify)", () => {
    expect(decide({ name: "read" }).block).toBe(false)
  })
})
