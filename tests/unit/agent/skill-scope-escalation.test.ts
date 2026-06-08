/**
 * ADR-0512 L3 — escalation decision (`decideScopeEscalation`).
 *
 * Verifies the fork: hand-off-required → hard deny WITHOUT asking; no onConfirm
 * → fail-closed deny; otherwise ask the user and map the ConfirmDecision verbs.
 * The hand-off-required and no-onConfirm cases are the security-load-bearing
 * ones (an out-of-scope tool must NEVER silently run).
 */

import { describe, expect, test } from "bun:test"
import { decideScopeEscalation } from "@/agent/skill-scope-escalation"
import type { ConfirmDecision } from "@/agent"
import type { ToolAction } from "@/permission"

const base = {
  tool: "edit",
  input: { path: "a.ts" },
  isReadOnly: false,
  activeSkill: "localize-fault",
  scopeReason: 'Tool "edit" is outside the active skill "localize-fault".',
} as const

describe("decideScopeEscalation", () => {
  test("hand-off-required ⇒ hard_deny, and onConfirm is NEVER called", async () => {
    let asked = false
    const v = await decideScopeEscalation({
      ...base,
      tier: "hand-off-required",
      onConfirm: async () => {
        asked = true
        return true
      },
    })
    expect(v.kind).toBe("hard_deny")
    expect(asked).toBe(false) // security boundary: not even asked
  })

  test("no onConfirm wired ⇒ deny (fail-closed, never silently admit)", async () => {
    const v = await decideScopeEscalation({ ...base, tier: "always-confirm", onConfirm: undefined })
    expect(v.kind).toBe("deny")
  })

  test("onConfirm true (allow) ⇒ dispatch", async () => {
    const v = await decideScopeEscalation({ ...base, tier: "none", onConfirm: async () => true })
    expect(v.kind).toBe("dispatch")
  })

  test("onConfirm false (deny) ⇒ deny", async () => {
    const v = await decideScopeEscalation({ ...base, tier: "none", onConfirm: async () => false })
    expect(v.kind).toBe("deny")
  })

  test("onConfirm deny_and_steer ⇒ deny_and_steer carrying the steer", async () => {
    const decision: ConfirmDecision = { decision: "deny_and_steer", steer: "use grep instead" }
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => decision,
    })
    expect(v).toEqual({ kind: "deny_and_steer", steer: "use grep instead" })
  })

  test("the action carries scopeContext so the surface renders a scope card", async () => {
    let seen: ToolAction | undefined
    await decideScopeEscalation({
      ...base,
      tier: "always-confirm",
      onConfirm: async (a) => {
        seen = a
        return true
      },
    })
    expect(seen?.scopeContext).toEqual({
      activeSkill: "localize-fault",
      reason: base.scopeReason,
    })
    expect(seen?.tool).toBe("edit")
    expect(seen?.isReadOnly).toBe(false)
  })
})
