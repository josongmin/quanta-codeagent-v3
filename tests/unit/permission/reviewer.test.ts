/**
 * Reviewer dispatcher tests (ADR-0029).
 *
 * Covers:
 *   - 3-tier dispatch (user / auto_review / guardian_subagent).
 *   - Sticky post-denial precedence (guardian_denied / user_aborted /
 *     user_denied — including precedence ordering).
 *   - DenialPrecedenceConflictError when two equally-strong denials disagree.
 *   - ReviewerUnavailableError when port lacks the requested method.
 *   - Port-returned decision invariant validation (OutcomeInvariantError).
 *
 * Port is a hand-rolled stub (no auto-mock) — assertions are explicit so
 * the test reads as a contract document.
 */
import { describe, expect, test } from "bun:test"
import {
  type ApprovalDecision,
  type DenialMemory,
  DenialPrecedenceConflictError,
  OutcomeInvariantError,
  type ReviewContext,
  type ReviewerPort,
  ReviewerUnavailableError,
  reviewAction,
  type ToolActionKeyed,
} from "@/permission"

const CLOCK = 1_700_000_000_000

const action = (overrides: Partial<ToolActionKeyed> = {}): ToolActionKeyed => ({
  tool: "bash",
  input: { command: "echo hi" },
  isReadOnly: false,
  actionKey: "bash:echo",
  ...overrides,
})

const ctx = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  sessionId: "s1",
  turnId: "t1",
  priorDenials: [],
  configReviewer: "auto_review",
  decidedAt: CLOCK,
  ...overrides,
})

const decision = (overrides: Partial<ApprovalDecision> = {}): ApprovalDecision => ({
  reviewer: "auto_review",
  outcome: "config_allowed",
  riskLevel: "low",
  rationale: "stub",
  decidedAt: CLOCK,
  ...overrides,
})

/** Minimal port-builder. Each tier defaults to a "this method should not be
 *  called" trap — the test must override the tier under test, so a
 *  cross-tier call is loudly visible. */
const makePort = (overrides: Partial<ReviewerPort> = {}): ReviewerPort => ({
  autoReview: async () => {
    throw new Error("autoReview should not be called in this scenario")
  },
  guardianReview: async () => {
    throw new Error("guardianReview should not be called in this scenario")
  },
  userReview: async () => {
    throw new Error("userReview should not be called in this scenario")
  },
  ...overrides,
})

describe("reviewer — 3-tier dispatch", () => {
  test("configReviewer=auto_review → port.autoReview is called", async () => {
    let called = 0
    const port = makePort({
      autoReview: async (a, c) => {
        called++
        expect(a.actionKey).toBe("bash:echo")
        expect(c.sessionId).toBe("s1")
        return decision({ reviewer: "auto_review", outcome: "config_allowed" })
      },
    })
    const out = await reviewAction(action(), ctx({ configReviewer: "auto_review" }), port)
    expect(called).toBe(1)
    expect(out.reviewer).toBe("auto_review")
    expect(out.outcome).toBe("config_allowed")
  })

  test("configReviewer=guardian_subagent → port.guardianReview is called", async () => {
    let called = 0
    const port = makePort({
      guardianReview: async () => {
        called++
        return decision({ reviewer: "guardian_subagent", outcome: "guardian_approved" })
      },
    })
    const out = await reviewAction(action(), ctx({ configReviewer: "guardian_subagent" }), port)
    expect(called).toBe(1)
    expect(out.reviewer).toBe("guardian_subagent")
    expect(out.outcome).toBe("guardian_approved")
  })

  test("configReviewer=user → port.userReview is called", async () => {
    let called = 0
    const port = makePort({
      userReview: async () => {
        called++
        return decision({ reviewer: "user", outcome: "user_approved" })
      },
    })
    const out = await reviewAction(action(), ctx({ configReviewer: "user" }), port)
    expect(called).toBe(1)
    expect(out.reviewer).toBe("user")
    expect(out.outcome).toBe("user_approved")
  })

  test("port decision is validated through buildDecision (invariant enforcement)", async () => {
    const port = makePort({
      autoReview: async () =>
        // auto_review × user_approved is INADMISSIBLE per the matrix.
        decision({ reviewer: "auto_review", outcome: "user_approved" }),
    })
    await expect(
      reviewAction(action(), ctx({ configReviewer: "auto_review" }), port),
    ).rejects.toBeInstanceOf(OutcomeInvariantError)
  })

  test("port decision with empty rationale → invariant error", async () => {
    const port = makePort({
      autoReview: async () => decision({ rationale: "" }),
    })
    await expect(
      reviewAction(action(), ctx({ configReviewer: "auto_review" }), port),
    ).rejects.toBeInstanceOf(OutcomeInvariantError)
  })
})

describe("reviewer — sticky post-denial precedence", () => {
  const stickyDenial = (overrides: Partial<DenialMemory> = {}): DenialMemory => ({
    sessionId: "s1",
    actionKey: "bash:echo",
    reviewer: "guardian_subagent",
    outcome: "guardian_denied",
    deniedAt: CLOCK - 1000,
    ...overrides,
  })

  test("prior guardian_denied short-circuits before port is called", async () => {
    let portCalls = 0
    const port = makePort({
      userReview: async () => {
        portCalls++
        return decision({ reviewer: "user", outcome: "user_approved" })
      },
      autoReview: async () => {
        portCalls++
        return decision()
      },
      guardianReview: async () => {
        portCalls++
        return decision({ reviewer: "guardian_subagent", outcome: "guardian_approved" })
      },
    })
    const out = await reviewAction(
      action(),
      ctx({ configReviewer: "user", priorDenials: [stickyDenial()] }),
      port,
    )
    expect(portCalls).toBe(0)
    expect(out.outcome).toBe("guardian_denied")
    expect(out.reviewer).toBe("guardian_subagent")
    expect(out.decidedAt).toBe(CLOCK)
  })

  test("prior user_aborted overrides everything (strongest rank)", async () => {
    const port = makePort()
    const out = await reviewAction(
      action(),
      ctx({
        configReviewer: "auto_review",
        priorDenials: [
          stickyDenial({ reviewer: "user", outcome: "user_aborted" }),
          stickyDenial({ reviewer: "guardian_subagent", outcome: "guardian_denied" }),
          stickyDenial({ reviewer: "user", outcome: "user_denied" }),
        ],
      }),
      port,
    )
    expect(out.outcome).toBe("user_aborted")
    expect(out.reviewer).toBe("user")
  })

  test("guardian_denied outranks user_denied", async () => {
    const port = makePort()
    const out = await reviewAction(
      action(),
      ctx({
        configReviewer: "auto_review",
        priorDenials: [
          stickyDenial({ reviewer: "user", outcome: "user_denied" }),
          stickyDenial({ reviewer: "guardian_subagent", outcome: "guardian_denied" }),
        ],
      }),
      port,
    )
    expect(out.outcome).toBe("guardian_denied")
  })

  test("priorDenials for a DIFFERENT actionKey do not short-circuit", async () => {
    let called = 0
    const port = makePort({
      autoReview: async () => {
        called++
        return decision({ reviewer: "auto_review", outcome: "config_allowed" })
      },
    })
    const out = await reviewAction(
      action({ actionKey: "bash:echo" }),
      ctx({
        configReviewer: "auto_review",
        priorDenials: [stickyDenial({ actionKey: "bash:rm" })],
      }),
      port,
    )
    expect(called).toBe(1)
    expect(out.outcome).toBe("config_allowed")
  })

  test("non-sticky outcomes in priorDenials are ignored", async () => {
    let called = 0
    const port = makePort({
      autoReview: async () => {
        called++
        return decision()
      },
    })
    const out = await reviewAction(
      action(),
      ctx({
        configReviewer: "auto_review",
        // user_approved is in priorDenials but is NOT a sticky-denial outcome
        priorDenials: [
          {
            sessionId: "s1",
            actionKey: "bash:echo",
            reviewer: "user",
            outcome: "user_approved",
            deniedAt: CLOCK - 100,
          },
        ],
      }),
      port,
    )
    expect(called).toBe(1)
    expect(out.outcome).toBe("config_allowed")
  })

  test("duplicate identical sticky records are deduped (no conflict)", async () => {
    const port = makePort()
    const d = stickyDenial({ deniedAt: CLOCK - 200 })
    const out = await reviewAction(
      action(),
      ctx({ configReviewer: "auto_review", priorDenials: [d, d, d] }),
      port,
    )
    expect(out.outcome).toBe("guardian_denied")
  })

  test("two equal-rank denials with different reviewers throw DenialPrecedenceConflictError", async () => {
    const port = makePort()
    await expect(
      reviewAction(
        action(),
        ctx({
          configReviewer: "auto_review",
          // Both are rank-3 (user_aborted) but distinguishable on reviewer —
          // genuine ambiguity.
          priorDenials: [
            stickyDenial({ reviewer: "user", outcome: "user_aborted", deniedAt: CLOCK - 200 }),
            stickyDenial({
              reviewer: "guardian_subagent",
              outcome: "user_aborted",
              deniedAt: CLOCK - 100,
            }),
          ],
        }),
        port,
      ),
    ).rejects.toBeInstanceOf(DenialPrecedenceConflictError)
  })
})

describe("reviewer — port availability", () => {
  test("missing autoReview method → ReviewerUnavailableError", async () => {
    const port = {
      // userReview/guardianReview present; autoReview absent (cast to any
      // would violate biome — instead we build a partial port literally and
      // pass it through the public API to exercise the runtime guard).
      autoReview: undefined as unknown as ReviewerPort["autoReview"],
      guardianReview: makePort().guardianReview,
      userReview: makePort().userReview,
    } satisfies ReviewerPort
    await expect(
      reviewAction(action(), ctx({ configReviewer: "auto_review" }), port),
    ).rejects.toBeInstanceOf(ReviewerUnavailableError)
  })

  test("missing guardianReview method → ReviewerUnavailableError", async () => {
    const port = {
      autoReview: makePort().autoReview,
      guardianReview: undefined as unknown as ReviewerPort["guardianReview"],
      userReview: makePort().userReview,
    } satisfies ReviewerPort
    await expect(
      reviewAction(action(), ctx({ configReviewer: "guardian_subagent" }), port),
    ).rejects.toBeInstanceOf(ReviewerUnavailableError)
  })

  test("missing userReview method → ReviewerUnavailableError", async () => {
    const port = {
      autoReview: makePort().autoReview,
      guardianReview: makePort().guardianReview,
      userReview: undefined as unknown as ReviewerPort["userReview"],
    } satisfies ReviewerPort
    await expect(
      reviewAction(action(), ctx({ configReviewer: "user" }), port),
    ).rejects.toBeInstanceOf(ReviewerUnavailableError)
  })

  test("ReviewerUnavailableError exposes the requested reviewer tier", async () => {
    const port = {
      autoReview: undefined as unknown as ReviewerPort["autoReview"],
      guardianReview: makePort().guardianReview,
      userReview: makePort().userReview,
    } satisfies ReviewerPort
    try {
      await reviewAction(action(), ctx({ configReviewer: "auto_review" }), port)
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewerUnavailableError)
      expect((e as ReviewerUnavailableError).reviewer).toBe("auto_review")
    }
  })
})

describe("reviewer — outcome variety", () => {
  test("auto_review can return not_needed (HITL 'none' style short-circuit)", async () => {
    const port = makePort({
      autoReview: async () =>
        decision({ reviewer: "auto_review", outcome: "not_needed", riskLevel: "low" }),
    })
    const out = await reviewAction(
      action({ isReadOnly: true, actionKey: "read:file" }),
      ctx({ configReviewer: "auto_review" }),
      port,
    )
    expect(out.outcome).toBe("not_needed")
  })

  test("user_approved_for_session is propagated unchanged", async () => {
    const port = makePort({
      userReview: async () =>
        decision({
          reviewer: "user",
          outcome: "user_approved_for_session",
          riskLevel: "high",
          rationale: "session-approve",
        }),
    })
    const out = await reviewAction(action(), ctx({ configReviewer: "user" }), port)
    expect(out.outcome).toBe("user_approved_for_session")
    expect(out.rationale).toBe("session-approve")
  })

  test("guardian_subagent returning guardian_denied is propagated", async () => {
    const port = makePort({
      guardianReview: async () =>
        decision({
          reviewer: "guardian_subagent",
          outcome: "guardian_denied",
          riskLevel: "high",
          rationale: "secondary-review-rejected",
        }),
    })
    const out = await reviewAction(action(), ctx({ configReviewer: "guardian_subagent" }), port)
    expect(out.outcome).toBe("guardian_denied")
    expect(out.rationale).toBe("secondary-review-rejected")
  })

  test("decidedAt from ctx is used during sticky replay (not original deniedAt)", async () => {
    const port = makePort()
    const out = await reviewAction(
      action(),
      ctx({
        decidedAt: CLOCK + 999,
        priorDenials: [
          {
            sessionId: "s1",
            actionKey: "bash:echo",
            reviewer: "guardian_subagent",
            outcome: "guardian_denied",
            deniedAt: CLOCK - 5000,
          },
        ],
      }),
      port,
    )
    expect(out.decidedAt).toBe(CLOCK + 999)
  })
})
