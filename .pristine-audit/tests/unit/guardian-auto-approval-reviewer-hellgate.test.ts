/**
 * HELLGATE — T03 guardian auto-approval reviewer, the WHOLE approval seam
 * (feature `03-guardian-auto-approval-reviewer`).
 *
 * The reviewer AXIS itself (user / auto_review / guardian_subagent dispatch, the
 * subagent-backed guardian, HARD_DENY-before-reviewer ordering) already exists —
 * this pins the BEHAVIORS the T03 delta promises end-to-end, driving the REAL
 * `evaluate` (HARD_DENY gate) and the REAL `reviewAction` dispatch with only the
 * reviewer's LLM child loop (`ReviewerRunner`) stubbed.
 *
 *   UC1  guardian auto-approves a safe command — the user reviewer (`onConfirm`)
 *        is NEVER consulted (no human prompt). [auto-but-safe]
 *   UC2  HARD_DENY runs BEFORE the reviewer: a destructive command is denied by
 *        `evaluate` so the gate never reaches the reviewer — even a guardian that
 *        WOULD approve the same command can't unblock it. [red-on-injection]
 *   UC4  default-OFF byte-identity: `configReviewer:"user"` routes to `onConfirm`
 *        exactly as the legacy path.
 *   UC5  cost/failure boundary: a guardian runner that fails (budget/timeout/
 *        crash → `ok:false`) fails CLOSED (deny), never auto-approves.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { createOnConfirmReviewerPort } from "@/agent/reviewer-port"
import { createSubagentBackedGuardianReview } from "@/agent/tier1/reviewer-subagent"
import {
  __resetAutoApprovalReviewObserver,
  type AutoApprovalReviewEvent,
  evaluate,
  isAllowed,
  type PermissionContext,
  type ReviewContext,
  type ReviewerPort,
  reviewAction,
  setAutoApprovalReviewObserver,
  type ToolAction,
  type ToolActionKeyed,
} from "@/permission"
import type { ReviewerRunner } from "@/tool/types"

const DECIDED_AT = 1_700_000_000_000

const ctx = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  sessionId: "s1",
  turnId: "t1",
  priorDenials: [],
  configReviewer: "guardian_subagent",
  decidedAt: DECIDED_AT,
  reviewKind: "terminal",
  ...overrides,
})

/** A safe, NON-read-only mutating action (so it reaches the guardian LLM rather
 *  than the read-only fast-path) that is NOT hard-denied. */
const safeMutating: ToolActionKeyed = {
  tool: "bash",
  input: { command: "mkdir -p build" },
  isReadOnly: false,
  actionKey: "bash:mkdir",
}

/** A clearly destructive command on the HARD_DENY list. */
const destructive: ToolAction = {
  tool: "bash",
  input: { command: "rm -rf /" },
  isReadOnly: false,
  shellCommand: "rm -rf /",
}

/** A ReviewerRunner stub returning canned guardian JSON; records prompt count. */
const runner = (finalText: string, ok = true): { run: ReviewerRunner; calls: () => number } => {
  let n = 0
  const run: ReviewerRunner = async () => {
    n += 1
    return { ok, finalText, turns: 1 }
  }
  return { run, calls: () => n }
}

/** The guardian binary-decoder reply shapes (see `reviewer-subagent.ts`). */
const APPROVE = JSON.stringify({ outcome: "guardian_approved", rationale: "creates a build dir" })
const DENY = JSON.stringify({ outcome: "guardian_denied", rationale: "unsafe" })

let onConfirmFired = 0
const onConfirmSpy = async (): Promise<boolean> => {
  onConfirmFired += 1
  return true // even if it DID fire, it would approve — so a UC1 failure is loud
}

const guardianPort = (run: ReviewerRunner): ReviewerPort =>
  createOnConfirmReviewerPort({
    onConfirm: onConfirmSpy,
    guardianReview: createSubagentBackedGuardianReview({ reviewer: run }),
  })

describe("UC1 — guardian auto-approves a safe command, no human prompt", () => {
  test("guardian APPROVE ⇒ allowed; onConfirm (user reviewer) never fires", async () => {
    onConfirmFired = 0
    const { run, calls } = runner(APPROVE)
    const dec = await reviewAction(safeMutating, ctx(), guardianPort(run))
    expect(dec.reviewer).toBe("guardian_subagent")
    expect(isAllowed(dec.outcome)).toBe(true)
    expect(calls()).toBe(1) // the guardian LLM actually rendered the verdict
    expect(onConfirmFired).toBe(0) // ← no human prompt: auto-but-safe
  })
})

describe("UC2 — HARD_DENY runs BEFORE the reviewer (red-on-injection)", () => {
  const askMode: PermissionContext = { mode: "default" }

  test("evaluate() denies a destructive command at the gate, before any reviewer", () => {
    const decision = evaluate(destructive, askMode)
    expect(decision.kind).toBe("deny")
    // Paired control — a benign mutation in the SAME mode surfaces `ask`
    // (→ reviewAndDecide → reviewer), proving the deny above is the HARD_DENY
    // gate short-circuiting BEFORE the reviewer, not the mode denying everything.
    const benign: ToolAction = {
      tool: "bash",
      input: { command: "mkdir build" },
      isReadOnly: false,
      shellCommand: "mkdir build",
    }
    expect(evaluate(benign, askMode).kind).toBe("ask")
  })

  test("a guardian that WOULD approve the same command cannot unblock it — the gate already denied", async () => {
    // Prove the danger is real: the guardian, if reached, approves `rm -rf /`.
    const { run } = runner(APPROVE)
    const keyed: ToolActionKeyed = { ...destructive, actionKey: "bash:rm" }
    const guardianVerdict = await reviewAction(keyed, ctx(), guardianPort(run))
    expect(isAllowed(guardianVerdict.outcome)).toBe(true) // ← the guardian is fallible
    // …but the GATE denies it first, so that approval is never consulted.
    expect(evaluate(destructive, askMode).kind).toBe("deny")
  })
})

describe("UC4 — default-OFF byte-identity: user reviewer routes to onConfirm", () => {
  test('configReviewer:"user" consults onConfirm exactly as the legacy path', async () => {
    onConfirmFired = 0
    const { run, calls } = runner(APPROVE)
    const dec = await reviewAction(safeMutating, ctx({ configReviewer: "user" }), guardianPort(run))
    expect(dec.reviewer).toBe("user")
    expect(onConfirmFired).toBe(1) // the human WAS prompted
    expect(calls()).toBe(0) // the guardian LLM was NOT run
  })
})

describe("UC5 — cost/failure boundary: guardian failure fails CLOSED", () => {
  test("runner ok:false (budget/timeout/crash) ⇒ deny, never auto-approve", async () => {
    const { run } = runner("", false)
    const dec = await reviewAction(safeMutating, ctx(), guardianPort(run))
    expect(isAllowed(dec.outcome)).toBe(false)
  })

  test("a malformed guardian reply ⇒ deny (fail-closed decode)", async () => {
    const { run } = runner("not json at all")
    const dec = await reviewAction(safeMutating, ctx(), guardianPort(run))
    expect(isAllowed(dec.outcome)).toBe(false)
  })

  test("an explicit guardian DENY ⇒ deny", async () => {
    const { run } = runner(DENY)
    const dec = await reviewAction(safeMutating, ctx(), guardianPort(run))
    expect(isAllowed(dec.outcome)).toBe(false)
  })
})

describe("delta-3 — auto-review observer surfaces the agent verdict (started→completed)", () => {
  afterEach(() => {
    __resetAutoApprovalReviewObserver()
  })

  test("guardian decision emits started THEN completed, carrying tool + toolCallId + outcome", async () => {
    const events: AutoApprovalReviewEvent[] = []
    setAutoApprovalReviewObserver({ observe: (e) => events.push(e) })
    const { run } = runner(APPROVE)
    await reviewAction(safeMutating, ctx({ toolCallId: "call_42" }), guardianPort(run))
    expect(events.map((e) => e.phase)).toEqual(["started", "completed"])
    expect(events.every((e) => e.toolCallId === "call_42" && e.tool === "bash")).toBe(true)
    expect(events.every((e) => e.reviewer === "guardian_subagent")).toBe(true)
    const completed = events[1] as AutoApprovalReviewEvent
    expect(completed.allowed).toBe(true)
    expect(completed.outcome).toBe("guardian_approved")
  })

  test("a guardian DENY surfaces completed with allowed:false", async () => {
    const events: AutoApprovalReviewEvent[] = []
    setAutoApprovalReviewObserver({ observe: (e) => events.push(e) })
    const { run } = runner(DENY)
    await reviewAction(safeMutating, ctx({ toolCallId: "c1" }), guardianPort(run))
    expect((events[1] as AutoApprovalReviewEvent).allowed).toBe(false)
  })

  test("the USER tier emits NO auto-review notice (only the agent tiers do)", async () => {
    const events: AutoApprovalReviewEvent[] = []
    setAutoApprovalReviewObserver({ observe: (e) => events.push(e) })
    const { run } = runner(APPROVE)
    await reviewAction(safeMutating, ctx({ configReviewer: "user" }), guardianPort(run))
    expect(events).toHaveLength(0)
  })

  test("a throwing observer never breaks the decision (fail-safe sink)", async () => {
    setAutoApprovalReviewObserver({
      observe: () => {
        throw new Error("UI sink blew up")
      },
    })
    const { run } = runner(APPROVE)
    const dec = await reviewAction(safeMutating, ctx({ toolCallId: "c1" }), guardianPort(run))
    expect(isAllowed(dec.outcome)).toBe(true) // decision survives the observer throw
  })

  test("default-OFF: no registered observer ⇒ no-op (no throw, decision intact)", async () => {
    __resetAutoApprovalReviewObserver()
    const { run } = runner(APPROVE)
    const dec = await reviewAction(safeMutating, ctx({ toolCallId: "c1" }), guardianPort(run))
    expect(isAllowed(dec.outcome)).toBe(true)
  })

  test("a THROWING reviewer still closes the lifecycle: started THEN a terminal completed", async () => {
    // Finding D — `started` fires before the (fallible) dispatch. If the port or
    // decision validation throws, the surface must NOT be left showing
    // "reviewing…" forever — a terminal `completed` (not-allowed) must close it,
    // and the original error must still propagate (the gate fail-closes on it).
    const events: AutoApprovalReviewEvent[] = []
    setAutoApprovalReviewObserver({ observe: (e) => events.push(e) })
    const throwingPort: ReviewerPort = createOnConfirmReviewerPort({
      onConfirm: onConfirmSpy,
      guardianReview: async () => {
        throw new Error("guardian transport blew up mid-review")
      },
    })
    await expect(
      reviewAction(safeMutating, ctx({ toolCallId: "c9" }), throwingPort),
    ).rejects.toThrow("guardian transport blew up")
    expect(events.map((e) => e.phase)).toEqual(["started", "completed"])
    const completed = events[1] as AutoApprovalReviewEvent
    expect(completed.allowed).toBe(false) // a failed review never reads as approved
    expect(completed.toolCallId).toBe("c9")
  })
})
