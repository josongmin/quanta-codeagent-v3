/**
 * ADR-0512 P3 — the interactive escalation EMIT hooks on `decideScopeEscalation`.
 *
 * The escalation decision module fires two OPTIONAL hooks around the actual
 * `onConfirm` ask so a surface can render a `permission_escalation_requested`
 * card and a `permission_escalation_resolved` follow-up:
 *
 *   - `onEscalationRequested(req)` fires EXACTLY when (and only when) the path
 *     is about to ASK the user (auto-run tier + an onConfirm is wired). It is
 *     NEVER fired for the security-load-bearing short-circuits:
 *       · hand-off-required  ⇒ hard_deny WITHOUT a request (security boundary)
 *       · no onConfirm        ⇒ fail-closed deny WITHOUT a request
 *       · bypass / acceptEdits ⇒ auto-dispatch WITHOUT a request
 *       · always-confirm       ⇒ defer to the tool's own gate WITHOUT a request
 *   - `onEscalationResolved(res)` fires after the ask resolves, carrying the
 *     4-verb decision (allow_once / allow_session / deny / deny_and_steer).
 *
 * These hooks are the surface-agnostic seam the stream-callbacks wire to
 * `config.stream.emit`. RED-on-injection: a hand-off-required escalation must
 * NEVER emit a request (it must be unaskable + uncardable).
 */

import { describe, expect, test } from "bun:test"
import type { ConfirmDecision } from "@/agent"
import {
  decideScopeEscalation,
  type EscalationRequest,
  type EscalationResolution,
} from "@/agent/skill-scope-escalation"

const base = {
  tool: "edit",
  input: { path: "a.ts" },
  isReadOnly: false,
  mode: "default",
  activeSkill: "localize-fault",
  scopeReason: 'Tool "edit" is outside the active skill "localize-fault".',
} as const

const collect = () => {
  const requested: EscalationRequest[] = []
  const resolved: EscalationResolution[] = []
  return {
    requested,
    resolved,
    onEscalationRequested: (r: EscalationRequest) => requested.push(r),
    onEscalationResolved: (r: EscalationResolution) => resolved.push(r),
  }
}

describe("decideScopeEscalation — P3 escalation emit hooks", () => {
  test("auto-run (none) tier WITH onConfirm ⇒ emits requested THEN resolved around the ask", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => true,
      justification: "fix the bug at src/foo.ts:42",
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("dispatch")
    expect(c.requested).toHaveLength(1)
    const req = c.requested[0]
    expect(req?.tool).toBe("edit")
    expect(req?.activeSkill).toBe("localize-fault")
    expect(req?.reason).toBe(base.scopeReason)
    expect(req?.risk).toBe("mutating") // !isReadOnly ⇒ mutating
    expect(req?.justification).toBe("fix the bug at src/foo.ts:42")
    expect(req?.options).toEqual(["allow_once", "allow_session", "deny", "deny_and_steer"])
    // resolved fires after, carrying the verb (approve ⇒ session widen)
    expect(c.resolved).toHaveLength(1)
    expect(c.resolved[0]?.decision).toBe("allow_session")
    expect(c.resolved[0]?.id).toBe(req?.id)
  })

  test("allow_once: approve {scope:'once'} ⇒ resolved decision 'allow_once' (no widen)", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => ({ decision: "allow", scope: "once" }),
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v).toEqual({ kind: "dispatch", widen: false })
    expect(c.resolved[0]?.decision).toBe("allow_once")
  })

  test("read-only tool ⇒ requested.risk = 'read-only'", async () => {
    const c = collect()
    await decideScopeEscalation({
      ...base,
      isReadOnly: true,
      tier: "none",
      onConfirm: async () => true,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(c.requested[0]?.risk).toBe("read-only")
  })

  test("deny ⇒ resolved decision 'deny'", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => false,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("deny")
    expect(c.requested).toHaveLength(1)
    expect(c.resolved[0]?.decision).toBe("deny")
  })

  test("deny_and_steer ⇒ resolved decision 'deny_and_steer'", async () => {
    const c = collect()
    const decision: ConfirmDecision = { decision: "deny_and_steer", steer: "use grep" }
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => decision,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("deny_and_steer")
    expect(c.resolved[0]?.decision).toBe("deny_and_steer")
  })

  // ── SECURITY: the request must NEVER be emitted on the short-circuits ──

  test("hand-off-required ⇒ NO requested, NO resolved (non-escalatable, uncardable)", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "hand-off-required",
      onConfirm: async () => true,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("hard_deny")
    expect(c.requested).toHaveLength(0) // RED-on-injection: no card for a security boundary
    expect(c.resolved).toHaveLength(0)
  })

  test("no onConfirm ⇒ fail-closed deny WITHOUT a request (nothing to render)", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: undefined,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("deny")
    expect(c.requested).toHaveLength(0)
    expect(c.resolved).toHaveLength(0)
  })

  test("bypass mode ⇒ auto-dispatch WITHOUT a request (user already lowered the gate)", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "none",
      mode: "bypass",
      onConfirm: async () => true,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("dispatch")
    expect(c.requested).toHaveLength(0)
  })

  test("always-confirm ⇒ defer to own gate WITHOUT a separate request", async () => {
    const c = collect()
    const v = await decideScopeEscalation({
      ...base,
      tier: "always-confirm",
      onConfirm: async () => true,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(v.kind).toBe("dispatch")
    expect(c.requested).toHaveLength(0)
  })

  test("request id is shared by requested + resolved so a surface can pair them", async () => {
    const c = collect()
    await decideScopeEscalation({
      ...base,
      tier: "none",
      onConfirm: async () => true,
      onEscalationRequested: c.onEscalationRequested,
      onEscalationResolved: c.onEscalationResolved,
    })
    expect(c.requested[0]?.id).toBeDefined()
    expect(c.resolved[0]?.id).toBe(c.requested[0]?.id)
  })
})
