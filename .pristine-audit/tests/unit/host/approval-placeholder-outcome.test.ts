import { describe, expect, test } from "bun:test"
import type { ToolAction } from "../../../src/permission"
import {
  approvalPlaceholderOutcome,
  escalationActorFields,
} from "../../../src/host/runtime/internal/context-binding/approval-support"
import { lastTurnOutcomeFromAgentOutcome } from "../../../src/reactor/agent-outcome-adapter"

/** A minimal ToolAction; the actor projection reads ONLY `teamEscalation`. */
const baseAction = (extra: Partial<ToolAction> = {}): ToolAction =>
  ({ tool: "shell", input: {}, isReadOnly: false, ...extra }) as ToolAction

/**
 * ALBB-18 (5) — a turn paused awaiting HITL approval must NOT report the
 * terminal user-cancelled reason `"aborted"`. It returns alongside an
 * `approvalRequest` (turn-runner.ts) and matches scheduler status
 * `"awaiting_approval"`, so `outcome.reason` must carry the dedicated pause
 * reason so a consumer can tell "paused, resume pending" from "cancelled".
 */
describe("ALBB-18 — approvalPlaceholderOutcome pause reason", () => {
  test("reports the dedicated pause reason, NOT aborted", () => {
    const out = approvalPlaceholderOutcome([])
    expect(out.reason).toBe("awaiting_approval")
    expect(out.reason).not.toBe("aborted")
  })

  test("SSOT classifier maps the pause reason to partial (resumable, not fail)", () => {
    const out = approvalPlaceholderOutcome([])
    expect(lastTurnOutcomeFromAgentOutcome(out)).toBe("partial")
  })
})

/**
 * RFC12-4 — the daemon projects the asking SUBAGENT's identity from the confirm
 * action's `teamEscalation` (the SAME field the CLI card reads) onto the
 * web-facing `PendingApprovalView.actor`. This is the front-door proof that the
 * actor value comes from the real payload, not a hardcode, and that a main-agent
 * confirm (no `teamEscalation`) projects NOTHING ⇒ byte-identical.
 */
describe("RFC12-4 — escalationActorFields projects the asking subagent", () => {
  test("projects workerId + scope from teamEscalation (mirrors the CLI source)", () => {
    const fields = escalationActorFields(
      baseAction({ teamEscalation: { workerId: "reviewer-agent", scope: "edit", reason: "fix" } }),
    )
    expect(fields.actor).toEqual({ workerId: "reviewer-agent", scope: "edit" })
  })

  test("distinct workerIds project distinctly (anti-vacuum: tracks the payload)", () => {
    const a = escalationActorFields(
      baseAction({ teamEscalation: { workerId: "alpha", scope: "s", reason: "r" } }),
    )
    const b = escalationActorFields(
      baseAction({ teamEscalation: { workerId: "omega", scope: "s", reason: "r" } }),
    )
    expect(a.actor?.workerId).toBe("alpha")
    expect(b.actor?.workerId).toBe("omega")
  })

  test("omits an empty scope but still names the worker", () => {
    const fields = escalationActorFields(
      baseAction({ teamEscalation: { workerId: "solo-agent", scope: "", reason: "r" } }),
    )
    expect(fields.actor).toEqual({ workerId: "solo-agent" })
  })

  test("main-agent confirm (no teamEscalation) projects NOTHING ⇒ byte-identical", () => {
    expect(escalationActorFields(baseAction())).toEqual({})
    // No `actor` key at all — the spread onto the approval is a no-op.
    expect("actor" in escalationActorFields(baseAction())).toBe(false)
  })
})
