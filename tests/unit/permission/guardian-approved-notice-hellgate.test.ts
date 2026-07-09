/**
 * UUX-1-21 HELLGATE — a guardian auto-approve must NEVER be silent in the
 * DEFAULT posture.
 *
 * Root cause: the `guardian_approved` outcome only fed the typed
 * `AutoApprovalReviewObserver` seam, and the CLI registers that observer ONLY
 * under the approval-ladder opt-in (`ladderAutoReviewEnabled()`). But
 * `selectDefaultReviewer` can pick `guardian_subagent` WITHOUT the ladder knob
 * (explicit per-thread authority `approvalPolicy=on-request` + workspace-write
 * sandbox, or the legacy `permissionMode=default` + workspace-write fallback)
 * — in those postures a tool ran with ZERO operator signal.
 *
 * Contract pinned here (fix = reviewer.ts emits through the WS-G
 * operator-notice bus when NO auto-approval observer is registered):
 *   1. default posture (no observer): guardian_approved ⇒ ONE info notice
 *      "guardian approved: <tool>".
 *   2. paired control — guardian_denied ⇒ NO notice (a denial surfaces
 *      through the gate's deny path already).
 *   3. paired control — ladder posture (observer registered): NO operator
 *      notice (the observer's tool_progress rendering already covers it;
 *      double-render would be chrome spam).
 *   4. user-approved outcomes ⇒ NO notice (a human just answered a prompt).
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetAutoApprovalReviewObserver,
  type ApprovalDecision,
  type ReviewContext,
  type ReviewerPort,
  reviewAction,
  setAutoApprovalReviewObserver,
  type ToolActionKeyed,
} from "@/permission"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"

const CLOCK = 1_700_000_000_000

const action = (tool = "bash"): ToolActionKeyed => ({
  tool,
  input: { command: "echo hi" },
  isReadOnly: false,
  actionKey: `${tool}:echo`,
})

const ctx = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  sessionId: "s1",
  turnId: "t1",
  priorDenials: [],
  configReviewer: "guardian_subagent",
  decidedAt: CLOCK,
  ...overrides,
})

const guardianDecision = (outcome: "guardian_approved" | "guardian_denied"): ApprovalDecision => ({
  reviewer: "guardian_subagent",
  outcome,
  riskLevel: "low",
  rationale: "stub",
  decidedAt: CLOCK,
})

const makePort = (overrides: Partial<ReviewerPort> = {}): ReviewerPort => ({
  autoReview: async () => {
    throw new Error("autoReview must not be called")
  },
  guardianReview: async () => {
    throw new Error("guardianReview must not be called")
  },
  userReview: async () => {
    throw new Error("userReview must not be called")
  },
  ...overrides,
})

const captureNotices = (): OperatorNotice[] => {
  const seen: OperatorNotice[] = []
  installOperatorNoticeSink((n) => seen.push(n))
  return seen
}

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  __resetAutoApprovalReviewObserver()
})

describe("UUX-1-21 — guardian auto-approve operator notice (default posture)", () => {
  test("guardian_approved with NO observer registered ⇒ one info notice naming the tool", async () => {
    const seen = captureNotices()
    const port = makePort({
      guardianReview: async () => guardianDecision("guardian_approved"),
    })
    const decision = await reviewAction(action("bash"), ctx(), port)
    expect(decision.outcome).toBe("guardian_approved")
    const guardianNotices = seen.filter((n) => n.message.includes("guardian approved"))
    expect(guardianNotices.length).toBe(1)
    const notice = guardianNotices[0] as OperatorNotice
    expect(notice.severity).toBe("info")
    expect(notice.message).toContain("guardian approved: bash")
  })

  test("paired control — guardian_denied ⇒ NO notice", async () => {
    const seen = captureNotices()
    const port = makePort({
      guardianReview: async () => guardianDecision("guardian_denied"),
    })
    const decision = await reviewAction(action("bash"), ctx(), port)
    expect(decision.outcome).toBe("guardian_denied")
    expect(seen.length).toBe(0)
  })

  test("paired control — ladder posture (observer registered) ⇒ NO operator notice (observer renders instead)", async () => {
    const observed: string[] = []
    setAutoApprovalReviewObserver({
      observe: (ev) => observed.push(ev.phase),
    })
    const seen = captureNotices()
    const port = makePort({
      guardianReview: async () => guardianDecision("guardian_approved"),
    })
    const decision = await reviewAction(action("bash"), ctx(), port)
    expect(decision.outcome).toBe("guardian_approved")
    // The typed observer DID see the lifecycle (started + completed)…
    expect(observed).toEqual(["started", "completed"])
    // …so the bus stays quiet (no double-render).
    expect(seen.length).toBe(0)
  })

  test("paired control — user tier approval ⇒ NO notice (human answered a visible prompt)", async () => {
    const seen = captureNotices()
    const port = makePort({
      userReview: async () => ({
        reviewer: "user",
        outcome: "user_approved",
        riskLevel: "low",
        rationale: "stub",
        decidedAt: CLOCK,
      }),
    })
    const decision = await reviewAction(action("bash"), ctx({ configReviewer: "user" }), port)
    expect(decision.outcome).toBe("user_approved")
    expect(seen.length).toBe(0)
  })
})
