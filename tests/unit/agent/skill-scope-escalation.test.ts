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
  mode: "default",
  activeSkill: "localize-fault",
  scopeReason: 'Tool "edit" is outside the active skill "localize-fault".',
} as const

describe("decideScopeEscalation", () => {
  test("hand-off-required ⇒ hard_deny, and onConfirm is NEVER called (security boundary)", async () => {
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
    expect(asked).toBe(false) // not even asked
  })

  test("hand-off-required is hard_deny EVEN in bypass mode (mode cannot relax security)", async () => {
    const v = await decideScopeEscalation({
      ...base,
      tier: "hand-off-required",
      mode: "bypass",
      onConfirm: async () => true,
    })
    expect(v.kind).toBe("hard_deny")
  })

  test("bypass / acceptEdits ⇒ dispatch WITHOUT asking (user lowered the gate)", async () => {
    for (const mode of ["bypass", "acceptEdits"] as const) {
      let asked = false
      const v = await decideScopeEscalation({
        ...base,
        tier: "none",
        mode,
        onConfirm: async () => {
          asked = true
          return false
        },
      })
      expect(v.kind).toBe("dispatch")
      expect(asked).toBe(false)
    }
  })

  test("always-confirm ⇒ dispatch without a SEPARATE scope ask (its own gate prompts)", async () => {
    let asked = false
    const v = await decideScopeEscalation({
      ...base,
      tier: "always-confirm",
      onConfirm: async () => {
        asked = true
        return true
      },
    })
    expect(v.kind).toBe("dispatch") // no double-prompt
    expect(asked).toBe(false)
  })

  test("auto-run tier (none) with no onConfirm ⇒ deny (fail-closed, never silently admit)", async () => {
    const v = await decideScopeEscalation({ ...base, tier: "none", onConfirm: undefined })
    expect(v.kind).toBe("deny")
  })

  test("auto-run tier (none) + onConfirm true ⇒ dispatch", async () => {
    const v = await decideScopeEscalation({ ...base, tier: "none", onConfirm: async () => true })
    expect(v.kind).toBe("dispatch")
  })

  test("auto-run tier (none) + onConfirm false ⇒ deny", async () => {
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
      tier: "none", // auto-run tier ⇒ this is the case that actually asks
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

  test("ADR-0512 allow_once: approve {scope:'once'} ⇒ dispatch WITHOUT widening", async () => {
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => ({ decision: "allow", scope: "once" }),
    })
    expect(v).toEqual({ kind: "dispatch", widen: false }) // re-asked next time
  })

  test("ADR-0512 allow_session: approve {scope:'session'} (or bare allow) ⇒ dispatch + widen", async () => {
    const session = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => ({ decision: "allow", scope: "session" }),
    })
    expect(session).toEqual({ kind: "dispatch", widen: true })
    const bare = await decideScopeEscalation({ ...base, tier: "none", onConfirm: async () => true })
    expect(bare).toEqual({ kind: "dispatch", widen: true }) // legacy approve = session
  })

  test("ADR-0512 justification: the model's rationale rides on action.scopeContext (web bridge)", async () => {
    let seen: ToolAction | undefined
    await decideScopeEscalation({
      ...base,
      tier: "none",
      justification: "need to read config to localize the bug",
      onConfirm: async (a) => {
        seen = a
        return true
      },
    })
    expect(seen?.scopeContext?.justification).toBe("need to read config to localize the bug")
  })

  test("bypass / always-confirm dispatch widen:true (consistent session admit)", async () => {
    const bypass = await decideScopeEscalation({
      ...base,
      tier: "none",
      mode: "bypass",
      onConfirm: async () => false,
    })
    expect(bypass).toEqual({ kind: "dispatch", widen: true })
    const ac = await decideScopeEscalation({ ...base, tier: "always-confirm", onConfirm: async () => false })
    expect(ac).toEqual({ kind: "dispatch", widen: true })
  })
})
