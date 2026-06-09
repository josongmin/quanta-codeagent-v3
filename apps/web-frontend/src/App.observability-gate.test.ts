import { describe, expect, it } from "vitest"
import type { ContextUsageMessage } from "./types/protocol"
import type { ObservabilityState } from "./ws/observability-hooks"
import { computeHasObservabilityData } from "./App"

/**
 * Auto-hide gate for the observability sidebar. The load-bearing invariant the
 * audit flagged: with NO observability data and NO canvas usage, the pane is
 * HIDDEN (chat takes full width). Tested as a pure function — no React renderer
 * (the test env is `node`, no DOM).
 */

const emptyObservability: ObservabilityState = {
  runs: [],
  objective: null,
  approvals: [],
  lastEmittedAt: 0,
}

const usage: ContextUsageMessage = {
  kind: "context.usage",
  segments: [],
  total: 1,
  max: 10,
  emittedAt: 0,
}

describe("computeHasObservabilityData (sidebar auto-hide gate)", () => {
  it("returns false when there is no data and no canvas usage (pane hidden)", () => {
    expect(computeHasObservabilityData(emptyObservability, null)).toBe(false)
  })

  it("returns true when context usage is present (canvas usage shows the pane)", () => {
    expect(computeHasObservabilityData(emptyObservability, usage)).toBe(true)
  })

  it("returns true when there is at least one run", () => {
    const state: ObservabilityState = {
      ...emptyObservability,
      runs: [
        {
          id: "r1",
          kind: "shell",
          owner: "agent",
          title: "ls",
          status: "running",
          startedAt: 0,
          lastEventAt: 0,
          artifacts: [],
        },
      ],
    }
    expect(computeHasObservabilityData(state, null)).toBe(true)
  })

  it("returns true when an objective is present", () => {
    const state: ObservabilityState = {
      ...emptyObservability,
      objective: {
        threadId: "t1",
        goal: "ship",
        successCriteria: [],
        status: "active",
        budget: { tokensUsed: 0, turnsUsed: 0 },
        blockers: [],
        nextActions: [],
        createdAt: 0,
        updatedAt: 0,
      },
    }
    expect(computeHasObservabilityData(state, null)).toBe(true)
  })

  it("returns true when there is a pending approval", () => {
    const state: ObservabilityState = {
      ...emptyObservability,
      approvals: [
        {
          id: "a1",
          threadId: "t1",
          kind: "permission",
          reason: "write file",
          proposedAction: "edit",
          resumeStep: "step-1",
          status: "pending",
          createdAt: 0,
        },
      ],
    }
    expect(computeHasObservabilityData(state, null)).toBe(true)
  })

  it("returns true when the canvas channel produced a tool diff", () => {
    // `hasDiffs=true` opens the pane so the DiffPanel column is not collapsed.
    expect(computeHasObservabilityData(emptyObservability, null, true)).toBe(true)
  })

  it("returns true when the agent-state channel carries a plan / axis (QUANTA_WEB_AGENT_STATE)", () => {
    // `hasAgentState=true` (a live plan OR mode/tool-progress/compaction/
    // ratelimit/plan-prompt) opens the sidebar so the agent-state column is not
    // rendered into a collapsed pane.
    expect(computeHasObservabilityData(emptyObservability, null, false, true)).toBe(true)
  })

  it("stays hidden when ONLY the default-OFF flags are false (byte-identical)", () => {
    // Both new opt-in flags default false ⇒ existing callers are byte-identical:
    // an empty observability state + no usage + no diffs + no agent-state ⇒ hidden.
    expect(computeHasObservabilityData(emptyObservability, null, false, false)).toBe(false)
  })
})
