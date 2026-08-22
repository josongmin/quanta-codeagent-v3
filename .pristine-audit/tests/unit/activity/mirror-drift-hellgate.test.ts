/**
 * Activity producer MIRROR DRIFT ratchet (jun-15 P0-a).
 *
 * The producers consume STRUCTURAL MIRRORS of upstream types (so the activity
 * slice does not value-import `@/workflow` / `@/subagent` / `@/side-agent`).
 * The risk (audit D10): if an upstream status union / event union gains a
 * member, the hand-mirrored copy does NOT, and `STATUS[x]` silently returns
 * `undefined`. This file pins the mirrors COMPILE-TIME: each real union must be
 * assignable INTO its mirror. Adding an upstream member breaks `bun run
 * typecheck` here — a forced, visible reconciliation.
 *
 * (Type-only imports ⇒ no runtime coupling; the assertions are erased.)
 */

import { describe, expect, test } from "bun:test"
import type { FleetRowLike, SideAgentStatusLike, WorkflowEventLike } from "@/activity"
import type { AgentFleetRow } from "@/apps/cli/agents-fleet-panel"
import type { SideAgentStatus } from "@/side-agent"
import type { WorkflowEvent } from "@/workflow"

/** Compile-time assignability: the upstream `Real` union must be a subset of
 *  the producer's `Mirror` union. A new upstream member fails `tsc` here. */
type Covers<Mirror, Real extends Mirror> = Real

// The load-bearing pins: real upstream union ⊆ producer mirror union.
type _FleetStatusPin = Covers<FleetRowLike["status"], AgentFleetRow["status"]>
type _SideStatusPin = Covers<SideAgentStatusLike, SideAgentStatus>
type _WfTypePin = Covers<WorkflowEventLike["type"], WorkflowEvent["type"]>

describe("activity mirror drift ratchet", () => {
  test("upstream status/event unions are covered by the producer mirrors", () => {
    // Runtime no-op; the teeth are the `Covers<...>` aliases above — they fail
    // `tsc` if an upstream union outgrows its mirror. Keep a live assertion so
    // the test is not empty.
    const sideStatuses: SideAgentStatusLike[] = ["running", "stopped", "failed", "idle-reaped"]
    const wfTypes: WorkflowEventLike["type"][] = [
      "phase_enter",
      "step_start",
      "step_complete",
      "step_skipped",
    ]
    expect(sideStatuses).toHaveLength(4)
    expect(wfTypes).toHaveLength(4)
    // touch the type aliases so they are not "unused" (erased at runtime)
    const _used: [_FleetStatusPin?, _SideStatusPin?, _WfTypePin?] = []
    expect(_used).toBeDefined()
  })
})
