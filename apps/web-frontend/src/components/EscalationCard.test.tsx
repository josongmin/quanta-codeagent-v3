import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { type EscalationApproval, EscalationCard } from "./EscalationCard"

const richApproval: EscalationApproval = {
  approvalId: "appr-1",
  reason: "approval required",
  scopeContext: {
    tool: "edit",
    activeSkill: "localize-fault",
    reason: "localize-fault is a read-only exploration skill",
    risk: "mutating",
    justification: "fix the bug at src/foo.ts:42",
  },
}

describe("EscalationCard", () => {
  it("renders the rich yellow card when an approval carries scopeContext", () => {
    const markup = renderToStaticMarkup(
      <EscalationCard approval={richApproval} onDecision={() => undefined} />,
    )
    // Active skill name surfaced.
    expect(markup).toContain("localize-fault")
    // Tool name surfaced.
    expect(markup).toContain("edit")
    // Risk read-only-vs-mutating distinction.
    expect(markup).toContain("mutating")
    // Reason + model justification.
    expect(markup).toContain("read-only exploration skill")
    expect(markup).toContain("src/foo.ts:42")
    // Yellow (warn) card, not a red error.
    expect(markup).toContain("warn")
    // 4 decision buttons present.
    expect(markup).toContain("Allow once")
    expect(markup).toContain("Allow session")
    expect(markup).toContain("Deny")
    expect(markup).toContain("Deny + steer")
  })

  it("omits the justification row when the model gave no justification", () => {
    const markup = renderToStaticMarkup(
      <EscalationCard
        approval={{
          approvalId: "appr-2",
          reason: "approval required",
          scopeContext: {
            tool: "web_fetch",
            activeSkill: "localize-fault",
            reason: "out of scope",
            risk: "read-only",
          },
        }}
        onDecision={() => undefined}
      />,
    )
    expect(markup).toContain("read-only")
    expect(markup).not.toContain("src/foo.ts:42")
  })

  it("renders a PLAIN approval (no scopeContext) without the rich card chrome", () => {
    const markup = renderToStaticMarkup(
      <EscalationCard
        approval={{ approvalId: "appr-3", reason: "shell command approval" }}
        onDecision={() => undefined}
      />,
    )
    // Plain approvals keep the existing approve/deny affordance — NO skill-scope
    // chrome (no active-skill line, no 4-verb escalation buttons).
    expect(markup).toContain("shell command approval")
    expect(markup).not.toContain("Allow session")
    expect(markup).not.toContain("Deny + steer")
  })

  it("maps the 4 escalation verbs onto onDecision (allow_session / deny / deny_and_steer)", () => {
    // renderToStaticMarkup can't fire DOM events; assert the verb→decision map
    // the component exposes is the ConfirmDecision-faithful one.
    const { escalationDecisionFor } = EscalationCard as unknown as {
      escalationDecisionFor: (v: string) => { decision: "approve" | "deny"; option: string }
    }
    expect(escalationDecisionFor("allow_once").decision).toBe("approve")
    expect(escalationDecisionFor("allow_session").decision).toBe("approve")
    expect(escalationDecisionFor("deny").decision).toBe("deny")
    expect(escalationDecisionFor("deny_and_steer").decision).toBe("deny")
  })

  it("invokes onDecision with the approvalId + decision when a button maps a verb", () => {
    const onDecision = vi.fn()
    // The component exposes a pure click-builder so the wiring is testable in a
    // node env without a DOM.
    const { buildDecisionHandler } = EscalationCard as unknown as {
      buildDecisionHandler: (
        approvalId: string,
        onDecision: (d: {
          approvalId: string
          decision: "approve" | "deny"
          option: string
        }) => void,
      ) => (option: string) => void
    }
    const handler = buildDecisionHandler("appr-9", onDecision)
    handler("allow_session")
    expect(onDecision).toHaveBeenCalledWith({
      approvalId: "appr-9",
      decision: "approve",
      option: "allow_session",
      scope: "session",
    })
  })

  // ADR-0512 P3 (jun-9 100-point) — the 4 verbs must be GENUINELY distinct on the
  // wire, not display-only: allow_once carries scope:"once" (no widen),
  // allow_session scope:"session" (widen), deny_and_steer carries the steer text.
  it("maps allow_once → scope:'once' and allow_session → scope:'session' (genuinely distinct)", () => {
    const { escalationDecisionFor } = EscalationCard as unknown as {
      escalationDecisionFor: (
        v: string,
        steer?: string,
      ) => { decision: "approve" | "deny"; option: string; scope?: string; steer?: string }
    }
    expect(escalationDecisionFor("allow_once")).toMatchObject({
      decision: "approve",
      scope: "once",
    })
    expect(escalationDecisionFor("allow_session")).toMatchObject({
      decision: "approve",
      scope: "session",
    })
    expect(escalationDecisionFor("deny")).toMatchObject({ decision: "deny" })
    expect(escalationDecisionFor("deny_and_steer", "use grep")).toMatchObject({
      decision: "deny",
      steer: "use grep",
    })
  })

  it("buildDecisionHandler threads scope for allow_once", () => {
    const onDecision = vi.fn()
    const { buildDecisionHandler } = EscalationCard as unknown as {
      buildDecisionHandler: (
        approvalId: string,
        onDecision: (d: {
          approvalId: string
          decision: "approve" | "deny"
          option: string
          scope?: string
        }) => void,
      ) => (option: string) => void
    }
    buildDecisionHandler("appr-1", onDecision)("allow_once")
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr-1", decision: "approve", scope: "once" }),
    )
  })

  it("the deny_and_steer button reveals a steer input AND carries the typed steer into the decision", () => {
    const markup = renderToStaticMarkup(
      <EscalationCard
        approval={{
          approvalId: "appr-2",
          reason: "esc",
          scopeContext: {
            tool: "edit",
            activeSkill: "reader",
            reason: "out of scope",
            risk: "mutating",
          },
        }}
        onDecision={() => {}}
      />,
    )
    // (a) The steer affordance is structurally present (a textarea to type into).
    expect(markup).toContain("textarea")
    // (b) The REAL anti-"silently drops the steer" guard: the exported decision
    //     seam the button calls carries the typed steer into a deny_and_steer
    //     decision (trimmed), and DROPS an empty/whitespace steer. Static render
    //     can't drive the click, so this pins the pure seam the button invokes
    //     — `toContain("textarea")` alone never proved the steer is read.
    const { escalationDecisionFor } = EscalationCard as unknown as {
      escalationDecisionFor: (
        option: string,
        steer?: string,
      ) => { decision: "approve" | "deny"; option: string; steer?: string }
    }
    expect(escalationDecisionFor("deny_and_steer", "go fix src/x.ts")).toEqual({
      decision: "deny",
      option: "deny_and_steer",
      steer: "go fix src/x.ts",
    })
    expect(escalationDecisionFor("deny_and_steer", "  go fix  ").steer).toBe("go fix") // trimmed
    expect(escalationDecisionFor("deny_and_steer", "   ").steer).toBeUndefined() // whitespace dropped
    expect(escalationDecisionFor("deny_and_steer", undefined).steer).toBeUndefined()
  })

  // UUX-2-18 (jul-10 W4) — clicking "Deny + steer" with an EMPTY steer box must
  // NOT silently degrade to a plain deny. The click keeps the user in the steer
  // input with an inline "steer text required (or choose Deny)" message; only a
  // non-empty steer dispatches. Plain "Deny" stays the no-text escape hatch.
  describe("UUX-2-18 — empty deny_and_steer keeps the user in the steer input", () => {
    type ClickResult =
      | {
          kind: "dispatch"
          decision: {
            approvalId: string
            decision: "approve" | "deny"
            option: string
            steer?: string
          }
        }
      | { kind: "steer-required"; message: string }
    const seam = EscalationCard as unknown as {
      resolveEscalationClick: (approvalId: string, option: string, steer?: string) => ClickResult
    }

    it("empty steer → steer-required, NEVER a dispatch (the silent-degrade is unrepresentable)", () => {
      const r = seam.resolveEscalationClick("appr-1", "deny_and_steer", "")
      expect(r.kind).toBe("steer-required")
      expect(r).toMatchObject({ message: "steer text required (or choose Deny)" })
    })

    it("whitespace-only steer is empty too", () => {
      expect(seam.resolveEscalationClick("appr-1", "deny_and_steer", "   \n\t ").kind).toBe(
        "steer-required",
      )
      expect(seam.resolveEscalationClick("appr-1", "deny_and_steer", undefined).kind).toBe(
        "steer-required",
      )
    })

    it("non-empty steer dispatches deny_and_steer with the trimmed steer", () => {
      const r = seam.resolveEscalationClick("appr-1", "deny_and_steer", "  use grep instead  ")
      expect(r).toEqual({
        kind: "dispatch",
        decision: {
          approvalId: "appr-1",
          decision: "deny",
          option: "deny_and_steer",
          steer: "use grep instead",
        },
      })
    })

    it("plain Deny (and the approves) dispatch regardless of the empty steer box (paired control)", () => {
      expect(seam.resolveEscalationClick("appr-1", "deny", "").kind).toBe("dispatch")
      expect(seam.resolveEscalationClick("appr-1", "allow_once", "").kind).toBe("dispatch")
      expect(seam.resolveEscalationClick("appr-1", "allow_session", "").kind).toBe("dispatch")
    })

    it("the inline validation renders next to the steer input (SSR seam), textarea kept", () => {
      const markup = renderToStaticMarkup(
        <EscalationCard
          approval={richApproval}
          onDecision={() => undefined}
          initialSteerError="steer text required (or choose Deny)"
        />,
      )
      expect(markup).toContain("steer text required (or choose Deny)")
      // The user stays in the steer flow: the textarea is still there and is
      // marked invalid for assistive tech.
      expect(markup).toContain("textarea")
      expect(markup).toContain('aria-invalid="true"')
      expect(markup).toContain('role="alert"')
    })

    it("no error state ⇒ no alert chrome (default render unchanged)", () => {
      const markup = renderToStaticMarkup(
        <EscalationCard approval={richApproval} onDecision={() => undefined} />,
      )
      expect(markup).not.toContain("steer text required")
      expect(markup).not.toContain('role="alert"')
    })
  })
})
