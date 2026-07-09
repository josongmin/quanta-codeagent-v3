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
import type { ApprovalRequest, RunEntry } from "../types/protocol"
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
