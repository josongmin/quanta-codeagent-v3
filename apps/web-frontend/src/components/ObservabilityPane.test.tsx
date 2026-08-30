/**
 * WS-F move 4 — observability honesty (UUX-2-09 / UUX-2-08).
 *
 *   - D-8: the Retry affordance is REMOVED — App never wired `onRetryRun`, so
 *     the button was permanently dead. No run row may render "Retry" until a
 *     real run-control endpoint exists.
 *   - Approvals: the pane renders an honest COUNT + link that scrolls to the
 *     live EscalationCard flow — not read-only rows that look actionable.
 *
 * Node test env: static markup via react-dom/server (matches KnobsPanel.test).
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ApprovalRequest, Objective, RunEntry } from "../types/protocol"
import type { ObservabilityState } from "../ws/observability-hooks"
import { ObservabilityPane } from "./ObservabilityPane"

const emptyState: ObservabilityState = {
  runs: [],
  objective: null,
  approvals: [],
  lastEmittedAt: 0,
}

const completedRun: RunEntry = {
  id: "run-1",
  kind: "task",
  title: "build the thing",
  status: "completed",
  updatedAt: "2026-07-10T00:00:00.000Z",
  artifacts: [],
} as unknown as RunEntry

const approval: ApprovalRequest = {
  id: "ap-1",
  reason: "wants to run rm -rf",
  proposedAction: "bash(rm -rf /tmp/x)",
  resumeStep: "approve to continue",
} as unknown as ApprovalRequest

describe("ObservabilityPane — Retry removal (UUX-2-09, D-8)", () => {
  it("never renders a Retry button for completed runs (the prop is gone)", () => {
    const html = renderToStaticMarkup(
      <ObservabilityPane state={{ ...emptyState, runs: [completedRun] }} />,
    )
    expect(html).not.toContain(">Retry<")
  })

  it("no onRetryRun prop survives in the pane's props contract", () => {
    // Compile-level fence: passing onRetryRun must be a type error. Runtime
    // fence: even if forced through, nothing renders it.
    const forced = { state: { ...emptyState, runs: [completedRun] } } as Record<string, unknown>
    forced.onRetryRun = () => undefined
    const html = renderToStaticMarkup(
      // @ts-expect-error — onRetryRun was removed (D-8); this pin keeps it dead
      <ObservabilityPane {...forced} />,
    )
    expect(html).not.toContain(">Retry<")
  })
})

describe("ObservabilityPane — honest approvals (UUX-2-08)", () => {
  it("renders the approvals COUNT with a link to the live approval card, not fake rows", () => {
    const html = renderToStaticMarkup(
      <ObservabilityPane state={{ ...emptyState, approvals: [approval] }} />,
    )
    expect(html).toContain("Pending approvals (1)")
    // The honest affordance: a link/button pointing at the live EscalationCard flow.
    expect(html).toContain("approval card")
    // The fake-actionable per-row detail (action/resume lines) is gone.
    expect(html).not.toContain("resume:")
    expect(html).not.toContain("bash(rm -rf /tmp/x)")
  })

  it("keeps the quiet empty card when nothing is pending", () => {
    const html = renderToStaticMarkup(<ObservabilityPane state={emptyState} />)
    expect(html).toContain("No approvals waiting.")
  })
})

describe("ObservabilityPane — goal authority projection", () => {
  // The fixture below could not be constructed before this packet: the mirror's
  // flat `SuccessCriterion` allowed a `checked` criterion with no `check` and a
  // completion receipt with no actor — objects the daemon can never send. It now
  // mirrors the daemon's discriminated shape, so the compiler refuses them.
  it("renders validation, remaining criteria, and budget", () => {
    const objective: Objective = {
      objectiveId: "goal-1",
      threadId: "thread-1",
      goal: "ship safely",
      createdBy: "user",
      successCriteria: [
        {
          kind: "checked",
          id: "tests",
          text: "tests pass",
          met: false,
          check: { id: "check-1", kind: "command", argv: ["bun", "test"] },
        },
        {
          kind: "manual",
          id: "docs",
          text: "docs updated",
          met: true,
          completion: { source: "manual", actor: "user" },
        },
      ],
      status: "active",
      budget: { turnsUsed: 2, maxTurns: 5, tokensUsed: 100, maxTokens: 500 },
      blockers: [],
      blockerObservations: [],
      nextActions: [],
      attempts: { autonomousTurnsStarted: 0 },
      createdAt: 1,
      updatedAt: 2,
    }
    const html = renderToStaticMarkup(<ObservabilityPane state={{ ...emptyState, objective }} />)
    expect(html).toContain("1/2 verified · checked")
    expect(html).toContain("Remaining:")
    expect(html).toContain("tests")
    expect(html).toContain("2/5 turns")
  })

  it("names the bound that stopped the goal, which the wire was already carrying", () => {
    const objective: Objective = {
      objectiveId: "goal-2",
      threadId: "thread-1",
      goal: "ship safely",
      createdBy: "user",
      successCriteria: [],
      status: "budget_limited",
      budget: {
        turnsUsed: 20,
        maxTurns: 20,
        tokensUsed: 1,
        limitedBy: "product-hard-cap",
      },
      blockers: [],
      blockerObservations: [],
      nextActions: [],
      attempts: { autonomousTurnsStarted: 20 },
      createdAt: 1,
      updatedAt: 2,
    }
    const html = renderToStaticMarkup(<ObservabilityPane state={{ ...emptyState, objective }} />)
    expect(html).toContain("limited by: product-hard-cap")
  })

  it("shows how close a blocked dependency is to promoting", () => {
    const objective: Objective = {
      objectiveId: "goal-3",
      threadId: "thread-1",
      goal: "ship safely",
      createdBy: "user",
      successCriteria: [],
      status: "active",
      budget: { turnsUsed: 1, tokensUsed: 1 },
      blockers: [],
      blockerObservations: [
        {
          observationId: "obs-1",
          dependencyRef: "approval:deploy",
          waitingOn: "user",
          distinctAttemptIds: ["a1", "a2"],
          lastObservedAt: 5,
        },
      ],
      nextActions: [],
      attempts: { autonomousTurnsStarted: 2 },
      createdAt: 1,
      updatedAt: 2,
    }
    const html = renderToStaticMarkup(<ObservabilityPane state={{ ...emptyState, objective }} />)
    expect(html).toContain("2/3 attempts")
  })
})
