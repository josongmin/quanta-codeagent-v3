/**
 * Activity producers hellgate (jun-15 P0-a) — each native source maps INTO the
 * SSOT spine vocabulary correctly.
 *
 *   A. workflow events → run/phase/agent tree                 (5)
 *   B. in-proc fleet rows → subagent nodes + status mapping   (4)
 *   C. side-agent snapshots → daemon nodes + status mapping   (3)
 */

import { describe, expect, test } from "bun:test"
import {
  type FleetRowLike,
  fleetRowToActivity,
  materialize,
  reduceAll,
  type SideAgentSnapshotLike,
  sideAgentToActivity,
  type WorkflowEventLike,
  workflowCloseActivity,
  workflowToActivity,
} from "@/activity"

// ── A. workflow ───────────────────────────────────────────────────────────

describe("workflowToActivity", () => {
  const events: WorkflowEventLike[] = [
    { type: "phase_enter", name: "Find" },
    { type: "step_start", id: "f1", label: "find:bugs" },
    { type: "step_complete", id: "f1", ok: true },
    { type: "phase_enter", name: "Verify" },
    { type: "step_start", id: "v1", label: "verify:bugs" },
    { type: "step_complete", id: "v1", ok: false },
    { type: "step_start", id: "v2", label: "verify:perf" },
    { type: "step_skipped", id: "v2" },
  ]
  const snap = () =>
    materialize(reduceAll([...workflowToActivity(events, { runId: "run", label: "review" })]))

  test("A1 — run root + phases nested, steps under their phase", () => {
    const s = snap()
    expect(s.roots).toEqual(["run"])
    expect(s.childIds.get("run")).toEqual(["run/phase/Find", "run/phase/Verify"])
    expect(s.childIds.get("run/phase/Find")).toEqual(["run/step/f1"])
    expect(s.childIds.get("run/phase/Verify")).toEqual(["run/step/v1", "run/step/v2"])
  })

  test("A2 — step_complete ok→done, !ok→failed, skipped→skipped", () => {
    const s = snap()
    expect(s.byId.get("run/step/f1")?.status).toBe("done")
    expect(s.byId.get("run/step/v1")?.status).toBe("failed")
    expect(s.byId.get("run/step/v2")?.status).toBe("skipped")
  })

  test("A3 — prior phase settles; its status is DERIVED from children (Find=done)", () => {
    const s = snap()
    expect(s.byId.get("run/phase/Find")?.status).toBe("done") // child f1 done
    // Verify is the open (last) phase; its children are failed+skipped (none
    // running) so it stays as the asserted in-progress `running`.
    expect(s.byId.get("run/phase/Verify")?.status).toBe("running")
  })

  test("A4 — a step before any phase attaches to the run root", () => {
    const s = materialize(
      reduceAll([
        ...workflowToActivity([{ type: "step_start", id: "s", label: "x" }], {
          runId: "r",
          label: "w",
        }),
      ]),
    )
    expect(s.childIds.get("r")).toEqual(["r/step/s"])
  })

  test("A5 — workflowCloseActivity derives last phase from events; honest fail", () => {
    // No manual phase name — close reads the last phase_enter ("Verify") itself.
    const close = workflowCloseActivity(events, { runId: "run", label: "review" }, false, 999)
    const s = materialize(
      reduceAll([...workflowToActivity(events, { runId: "run", label: "review" }), ...close]),
    )
    expect(s.byId.get("run")?.endedAt).toBe(999)
    // Verify is closed (done signal) but has a failed child ⇒ DERIVES failed.
    expect(s.byId.get("run/phase/Verify")?.status).toBe("failed")
    // run closed + a failed descendant ⇒ failed.
    expect(s.byId.get("run")?.status).toBe("failed")
  })

  test("A6 — a start-less step_skipped is still VISIBLE (not silently dropped)", () => {
    const s = materialize(
      reduceAll([
        ...workflowToActivity([{ type: "step_skipped", id: "s9" }], { runId: "r", label: "w" }),
      ]),
    )
    expect(s.byId.get("r/step/s9")?.status).toBe("skipped") // opened then skipped
  })

  test("A7 — `/` in a phase name cannot break id namespacing", () => {
    const s = materialize(
      reduceAll([
        ...workflowToActivity(
          [
            { type: "phase_enter", name: "a/b" },
            { type: "step_start", id: "s", label: "x" },
          ],
          { runId: "run", label: "w" },
        ),
      ]),
    )
    // the phase name is url-encoded, so "a/b" becomes one segment, not two
    expect(s.childIds.get("run")).toEqual(["run/phase/a%2Fb"])
    expect(s.childIds.get("run/phase/a%2Fb")).toEqual(["run/step/s"])
  })
})

// ── B. in-proc fleet ──────────────────────────────────────────────────────

describe("fleetRowToActivity", () => {
  const row = (over: Partial<FleetRowLike>): FleetRowLike => ({
    id: "t1",
    description: "investigate",
    status: "running",
    startedAt: 100,
    ...over,
  })

  test("B1 — running row ⇒ a single open (no close)", () => {
    const evts = fleetRowToActivity(row({}))
    expect(evts).toHaveLength(1)
    expect(evts[0]?.type).toBe("node_open")
    const s = materialize(reduceAll([...evts]))
    expect(s.byId.get("t1")?.kind).toBe("subagent")
    expect(s.byId.get("t1")?.status).toBe("running")
    expect(s.byId.get("t1")?.startedAt).toBe(100)
  })

  test("B2 — settled vocabulary maps: completed→done, failed→failed, stopped→stopped", () => {
    for (const [src, dst] of [
      ["completed", "done"],
      ["failed", "failed"],
      ["stopped", "stopped"],
    ] as const) {
      const s = materialize(reduceAll([...fleetRowToActivity(row({ status: src, endedAt: 200 }))]))
      expect(s.byId.get("t1")?.status).toBe(dst)
      expect(s.byId.get("t1")?.endedAt).toBe(200)
    }
  })

  test("B3 — result.turns + agentType surfaced via meta", () => {
    const s = materialize(
      reduceAll([
        ...fleetRowToActivity(
          row({
            status: "completed",
            agentType: "Explore",
            result: { ok: true, finalText: "x", turns: 4 },
          }),
        ),
      ]),
    )
    expect(s.byId.get("t1")?.meta).toEqual({ agentType: "Explore", turns: "4" })
  })

  test("B4 — fleet row is an L0 root (parentId null)", () => {
    const s = materialize(reduceAll([...fleetRowToActivity(row({}))]))
    expect(s.roots).toEqual(["t1"])
    expect(s.byId.get("t1")?.parentId).toBeNull()
  })
})

// ── C. side-agent daemons ──────────────────────────────────────────────────

describe("sideAgentToActivity", () => {
  const snap = (over: Partial<SideAgentSnapshotLike>): SideAgentSnapshotLike => ({
    id: "d1",
    label: "indexer",
    status: "running",
    wakesDone: 3,
    startedAt: 10,
    ...over,
  })

  test("C1 — daemon kind, wakes in meta", () => {
    const s = materialize(reduceAll([...sideAgentToActivity(snap({}))]))
    expect(s.byId.get("d1")?.kind).toBe("daemon")
    expect(s.byId.get("d1")?.meta).toEqual({ wakes: "3" })
  })

  test("C2 — status map: idle-reaped→stopped, failed→failed", () => {
    const reaped = materialize(
      reduceAll([...sideAgentToActivity(snap({ status: "idle-reaped", stoppedAt: 99 }))]),
    )
    expect(reaped.byId.get("d1")?.status).toBe("stopped")
    expect(reaped.byId.get("d1")?.endedAt).toBe(99)
    const failed = materialize(
      reduceAll([...sideAgentToActivity(snap({ status: "failed", stoppedAt: 50 }))]),
    )
    expect(failed.byId.get("d1")?.status).toBe("failed")
  })

  test("C3 — running daemon ⇒ single open", () => {
    expect(sideAgentToActivity(snap({})).filter((e) => e.type === "node_status")).toHaveLength(0)
  })
})
