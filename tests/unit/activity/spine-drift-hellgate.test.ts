/**
 * Activity spine DRIFT RATCHET (jun-15 P0-a) — the single-source proof.
 *
 * The whole point of the spine: fleet (L0) and the run tree (L1/L2) are DERIVED
 * from one snapshot, so they can never disagree. This pins three invariants:
 *   1. Round-trip fidelity: producers → spine → projectFleet reproduces the
 *      source rows' membership + status (no lost/ghost agents).
 *   2. Cross-projection agreement: a fleet row's rolled-up token total EQUALS
 *      the sum over the same root's subtree in projectTree (two projections,
 *      one truth).
 *   3. Heterogeneous sources (workflow + subagent + daemon) coexist as distinct
 *      L0 roots with correct per-root rollups — no cross-source bleed.
 *
 * Mirrors the T01 item-stream drift ratchet idiom: independent projections of
 * the SAME ordered event stream must agree.
 */

import { describe, expect, test } from "bun:test"
import {
  type ActivityTreeNode,
  type FleetRowLike,
  fleetToActivity,
  materialize,
  projectFleet,
  projectTree,
  reduceAll,
  sideAgentsToActivity,
  type WorkflowEventLike,
  workflowToActivity,
} from "@/activity"

/** Sum tokens over a tree node + all descendants (independent of projectFleet's
 *  own rollup — a SECOND implementation, so agreement is meaningful). */
const treeTokens = (t: ActivityTreeNode): number =>
  t.node.tokens + t.children.reduce((acc, c) => acc + treeTokens(c), 0)

describe("spine drift ratchet — single source of truth", () => {
  test("1 — fleet rows round-trip: projectFleet membership+status == source rows", () => {
    const rows: FleetRowLike[] = [
      { id: "a", description: "x", status: "running", startedAt: 1 },
      { id: "b", description: "y", status: "completed", startedAt: 2, endedAt: 9 },
      { id: "c", description: "z", status: "failed", startedAt: 3, endedAt: 8 },
    ]
    const fleet = projectFleet(materialize(reduceAll([...fleetToActivity(rows)])))
    // membership preserved, order preserved (first-seen)
    expect(fleet.map((r) => r.id)).toEqual(["a", "b", "c"])
    // status mapped via the SSOT vocabulary
    expect(fleet.map((r) => r.status)).toEqual(["running", "done", "failed"])
  })

  test("2 — cross-projection agreement: projectFleet rollup == projectTree subtree sum", () => {
    const events: WorkflowEventLike[] = [
      { type: "phase_enter", name: "P1" },
      { type: "step_start", id: "s1", label: "a" },
      { type: "step_start", id: "s2", label: "b" },
    ]
    const acts = [
      ...workflowToActivity(events, { runId: "run", label: "w" }),
      { type: "node_metric", id: "run/step/s1", tokensDelta: 100 } as const,
      { type: "node_metric", id: "run/step/s2", tokensDelta: 250 } as const,
      { type: "node_metric", id: "run", tokensDelta: 7 } as const,
    ]
    const s = materialize(reduceAll(acts))
    const fleet = projectFleet(s)
    const runRow = fleet.find((r) => r.id === "run")
    const runTree = projectTree(s, "run")[0]
    expect(runRow?.tokens).toBe(357) // 7 + 100 + 250
    // the two projections agree (computed by independent code paths)
    expect(runRow?.tokens).toBe(treeTokens(runTree as ActivityTreeNode))
    expect(runRow?.descendants).toBe(3) // P1, s1, s2
    expect(runRow?.running).toBe(3) // all still running
  })

  test("3 — heterogeneous sources coexist as distinct roots, no cross-bleed", () => {
    const wf = workflowToActivity(
      [{ type: "step_start", id: "s1", label: "a" }],
      { runId: "wf", label: "review" },
    )
    const subs = fleetToActivity([{ id: "sub", description: "x", status: "running", startedAt: 1 }])
    const daemons = sideAgentsToActivity([
      { id: "dae", label: "indexer", status: "running", wakesDone: 2, startedAt: 1 },
    ])
    const s = materialize(reduceAll([...wf, ...subs, ...daemons]))
    const fleet = projectFleet(s)
    expect(fleet.map((r) => r.id).sort()).toEqual(["dae", "sub", "wf"])
    expect(fleet.find((r) => r.id === "wf")?.kind).toBe("workflow")
    expect(fleet.find((r) => r.id === "sub")?.kind).toBe("subagent")
    expect(fleet.find((r) => r.id === "dae")?.kind).toBe("daemon")
    // wf's step is its descendant; sub/dae have none ⇒ no bleed
    expect(fleet.find((r) => r.id === "wf")?.descendants).toBe(1)
    expect(fleet.find((r) => r.id === "sub")?.descendants).toBe(0)
    expect(fleet.find((r) => r.id === "dae")?.descendants).toBe(0)
  })

  test("4 — aggregate equals the sum over fleet rows (header line == lanes)", () => {
    const rows: FleetRowLike[] = [
      { id: "a", description: "x", status: "running", startedAt: 1 },
      { id: "b", description: "y", status: "running", startedAt: 1 },
      { id: "c", description: "z", status: "completed", startedAt: 1, endedAt: 2 },
    ]
    const s = materialize(reduceAll([...fleetToActivity(rows)]))
    const fleet = projectFleet(s)
    // top-level running count in the aggregate == running roots in the fleet
    const runningRoots = fleet.filter((r) => r.status === "running").length
    expect(s.aggregate.running).toBe(runningRoots)
    expect(s.aggregate.agents).toBe(3) // all subagent-kind
  })

  test("5 — cycle-safe: a malformed parent cycle does not hang the projections", () => {
    // Hand-craft a 2-node cycle (a producer bug) and assert projections return.
    const s = materialize(
      reduceAll([
        { type: "node_open", node: { id: "x", parentId: "y", kind: "agent", label: "x" } },
        { type: "node_open", node: { id: "y", parentId: "x", kind: "agent", label: "y" } },
        { type: "node_metric", id: "x", tokensDelta: 5 },
      ]),
    )
    // neither is a root (both have parents), but projections must terminate
    expect(() => projectFleet(s)).not.toThrow()
    expect(() => projectTree(s, "x")).not.toThrow()
    const tree = projectTree(s, "x")[0]
    expect(treeTokens(tree as ActivityTreeNode)).toBe(5) // y visited once, no infinite loop
  })
})
