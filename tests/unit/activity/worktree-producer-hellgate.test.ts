/**
 * RFC02-5 worktree operation-correlation producer hellgate (aug-02 absorption).
 *
 * The FIRST real operation-correlated producer maps a worktree transition's
 * lifecycle INTO the SSOT spine vocabulary as ONE correlated node:
 *   A. open → a `running` node carrying the stable OperationCorrelation      (3)
 *   B. settle → a SINGLE terminal, `ready`→done / `failed`→failed            (3)
 *   C. correlation cardinality + id stability (anti-vacuum / red-on-injection)(3)
 */

import { describe, expect, test } from "bun:test"
import {
  materialize,
  reduceAll,
  worktreeOpenActivity,
  worktreeOpNodeId,
  worktreeSettleActivity,
} from "@/activity"

const openOpts = {
  operationId: "op-123",
  threadId: "thread-A",
  turnId: "turn-7",
  runId: "run-9",
  label: "worktree: fork-x",
  startedAt: 1000,
}

// ── A. open → running node + correlation ────────────────────────────────────

describe("worktreeOpenActivity", () => {
  test("A1 — opens a single `running` phase node at the stable op id", () => {
    const s = materialize(reduceAll([worktreeOpenActivity(openOpts)]))
    const id = worktreeOpNodeId("op-123")
    expect(s.roots).toEqual([id])
    const n = s.byId.get(id)
    expect(n?.kind).toBe("phase")
    expect(n?.status).toBe("running")
    expect(n?.label).toBe("worktree: fork-x")
    expect(n?.startedAt).toBe(1000)
  })

  test("A2 — carries the FULL correlation (operation/thread/turn/run/seq/at)", () => {
    const s = materialize(reduceAll([worktreeOpenActivity(openOpts)]))
    const c = s.byId.get(worktreeOpNodeId("op-123"))?.correlation
    expect(c).toEqual({
      operationId: "op-123",
      threadId: "thread-A",
      turnId: "turn-7",
      runId: "run-9",
      sequence: 0,
      occurredAt: 1000,
    })
  })

  test("A3 — optional turn/run omitted ⇒ correlation still valid (min shape)", () => {
    const ev = worktreeOpenActivity({
      operationId: "op-min",
      threadId: "t",
      label: "l",
      startedAt: 5,
    })
    const c = materialize(reduceAll([ev])).byId.get(worktreeOpNodeId("op-min"))?.correlation
    expect(c).toEqual({ operationId: "op-min", threadId: "t", sequence: 0, occurredAt: 5 })
    // anti-vacuum: absent optionals are OMITTED, not present-as-undefined.
    expect(Object.hasOwn(c ?? {}, "turnId")).toBe(false)
    expect(Object.hasOwn(c ?? {}, "runId")).toBe(false)
  })
})

// ── B. settle → single terminal, mapped through the SSOT table ──────────────

describe("worktreeSettleActivity", () => {
  test("B1 — ready → done (single terminal, endedAt stamped)", () => {
    const events = [worktreeOpenActivity(openOpts), worktreeSettleActivity("op-123", "ready", 2000)]
    const n = materialize(reduceAll(events)).byId.get(worktreeOpNodeId("op-123"))
    expect(n?.status).toBe("done")
    expect(n?.endedAt).toBe(2000)
  })

  test("B2 — failed → failed (single terminal)", () => {
    const events = [
      worktreeOpenActivity(openOpts),
      worktreeSettleActivity("op-123", "failed", 3000),
    ]
    const n = materialize(reduceAll(events)).byId.get(worktreeOpNodeId("op-123"))
    expect(n?.status).toBe("failed")
    expect(n?.endedAt).toBe(3000)
  })

  test("B3 — terminal targets the SAME node id as open (correlation by id)", () => {
    // The settle carries no correlation payload; it correlates purely by
    // landing on the node the open minted. If the id scheme drifted, the
    // status would drop (NO-THROW) and the node would still read running —
    // this asserts the terminal actually LANDS.
    const settle = worktreeSettleActivity("op-123", "ready", 2000)
    expect(settle.type).toBe("node_status")
    if (settle.type === "node_status") expect(settle.id).toBe(worktreeOpNodeId("op-123"))
  })
})

// ── C. cardinality + id stability (red-on-injection) ────────────────────────

describe("correlation cardinality + id stability", () => {
  test("C1 — node id is a STABLE fn of operationId only (no dynamic value)", () => {
    // Same operationId ⇒ byte-identical id regardless of label/thread/turn.
    expect(worktreeOpNodeId("op-x")).toBe(worktreeOpNodeId("op-x"))
    // A `/` in the id is url-encoded so it cannot break the namespace/alias a
    // sibling (mirrors the workflow producer's wfSeg discipline).
    expect(worktreeOpNodeId("a/b")).toBe("worktree-op/a%2Fb")
    expect(worktreeOpNodeId("a/b")).not.toBe(worktreeOpNodeId("a").concat("/b"))
  })

  test("C2 — re-open with the SAME op id is idempotent identity (correlation immutable)", () => {
    // A producer that re-emits open (reconnect) must NOT rewrite the correlation.
    const first = worktreeOpenActivity(openOpts)
    const reopen = worktreeOpenActivity({ ...openOpts, label: "relabelled", startedAt: 9999 })
    const s = materialize(reduceAll([first, reopen]))
    const n = s.byId.get(worktreeOpNodeId("op-123"))
    expect(n?.label).toBe("relabelled") // presentational refresh allowed
    expect(n?.correlation?.occurredAt).toBe(1000) // identity: original correlation kept
    expect(n?.startedAt).toBe(1000)
  })

  test("C3 — settle for an unknown op id is a NO-THROW drop (no phantom node)", () => {
    const s = materialize(reduceAll([worktreeSettleActivity("ghost", "ready", 1)]))
    expect(s.byId.has(worktreeOpNodeId("ghost"))).toBe(false)
    expect(s.roots).toEqual([])
  })
})
