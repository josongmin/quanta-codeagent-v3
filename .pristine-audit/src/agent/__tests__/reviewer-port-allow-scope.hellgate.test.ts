/**
 * ★ HELLGATE — WS-A (jul-10 uiux structural, UUX-2-20): the reviewer port must
 *   preserve the operator's allow SCOPE.
 *
 * Pinned bug: `createOnConfirmReviewerPort` emitted a fixed `approveOutcome`
 * (default `"user_approved"`) for EVERY allow — an operator answering
 * "[a]lways session" (`{decision:"allow", scope:"session"}`) was collapsed to a
 * one-shot approval, so the same action re-prompted forever.
 *
 * Contract under test (uses the EXISTING ApprovalOutcome vocabulary — no new
 * protocol): scope "session"/"session_prefix" ⇒ `user_approved_for_session`;
 * scope "once" ⇒ `user_approved` (an explicit ONCE is never widened by the
 * configured default); no scope ⇒ the configured `approveOutcome` default.
 */
import { describe, expect, test } from "bun:test"
import type { ReviewContext, ToolActionKeyed } from "@/permission"
import { createOnConfirmReviewerPort } from "../reviewer-port"

const action: ToolActionKeyed = {
  tool: "shell",
  input: { command: "git push" },
  isReadOnly: false,
  actionKey: "shell:git push",
}

const ctx: ReviewContext = {
  sessionId: "s1",
  turnId: "t1",
  priorDenials: [],
  configReviewer: "user",
  decidedAt: 1,
}

describe("HELLGATE WS-A — reviewer port preserves the operator's allow scope", () => {
  test("allow scope:'session' ⇒ user_approved_for_session (sticky, not one-shot)", async () => {
    const port = createOnConfirmReviewerPort({
      onConfirm: async () => ({ decision: "allow", scope: "session" }),
    })
    const out = await port.userReview(action, ctx)
    expect(out.outcome).toBe("user_approved_for_session")
  })

  test("allow scope:'session_prefix' ⇒ user_approved_for_session", async () => {
    const port = createOnConfirmReviewerPort({
      onConfirm: async () => ({ decision: "allow", scope: "session_prefix" }),
    })
    const out = await port.userReview(action, ctx)
    expect(out.outcome).toBe("user_approved_for_session")
  })

  test("EXPLICIT allow scope:'once' is never widened, even when the default is session", async () => {
    const port = createOnConfirmReviewerPort({
      onConfirm: async () => ({ decision: "allow", scope: "once" }),
      approveOutcome: "user_approved_for_session",
    })
    const out = await port.userReview(action, ctx)
    expect(out.outcome).toBe("user_approved")
  })

  test("legacy boolean true ⇒ the configured default outcome (byte-identical)", async () => {
    const port = createOnConfirmReviewerPort({ onConfirm: async () => true })
    const out = await port.userReview(action, ctx)
    expect(out.outcome).toBe("user_approved")
  })

  test("scopeless rich allow ⇒ the configured default outcome (byte-identical)", async () => {
    const port = createOnConfirmReviewerPort({
      onConfirm: async () => ({ decision: "allow" }),
      approveOutcome: "user_approved_for_session",
    })
    const out = await port.userReview(action, ctx)
    expect(out.outcome).toBe("user_approved_for_session")
  })

  test("deny paths unchanged (paired control)", async () => {
    const port = createOnConfirmReviewerPort({ onConfirm: async () => false })
    const out = await port.userReview(action, ctx)
    expect(out.outcome).toBe("user_denied")
  })
})
