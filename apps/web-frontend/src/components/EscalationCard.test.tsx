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
    })
  })
})
