/**
 * Activity spine — pure reducer + materializer hellgate (jun-15 P0-a).
 *
 *   A. node_open: defaults, idempotent re-open, child/root order   (5)
 *   B. node_status: transitions, terminal stamping, stuck set/clear, NO-THROW (6)
 *   C. node_metric: accumulate, unknown-id drop, non-finite/zero guard (4)
 *   D. materialize: tree nesting, aggregate, determinism            (5)
 */

import { describe, expect, test } from "bun:test"
import {
  type ActivityKind,
  type AgentActivityEvent,
  emptyActivityState,
  materialize,
  reduceActivity,
  reduceAll,
} from "@/activity"

const open = (
  id: string,
  parentId: string | null,
  kind: ActivityKind = "agent",
  label = id,
): AgentActivityEvent => ({ type: "node_open", node: { id, parentId, kind, label } })

const snap = (events: AgentActivityEvent[]) => materialize(reduceAll(events))

// ── A. node_open ────────────────────────────────────────────────────────

describe("reduceActivity — node_open", () => {
  test("A1 — opened node gets defaults (running, 0 counters)", () => {
    const s = snap([open("a", null, "workflow")])
    const n = s.byId.get("a")
    expect(n?.status).toBe("running")
    expect(n?.tokens).toBe(0)
    expect(n?.toolCalls).toBe(0)
  })

  test("A2 — explicit status on open is honoured", () => {
    const s = snap([{ type: "node_open", node: { id: "a", parentId: null, kind: "agent", label: "x", status: "pending" } }])
    expect(s.byId.get("a")?.status).toBe("pending")
  })

  test("A3 — roots in FIRST-SEEN order; children nested under parent", () => {
    const s = snap([open("r2", null, "workflow"), open("r1", null, "workflow"), open("c", "r2", "agent")])
    expect(s.roots).toEqual(["r2", "r1"]) // insertion order, NOT sorted
    expect(s.childIds.get("r2")).toEqual(["c"])
    expect(s.childIds.get("r1")).toBeUndefined()
  })

  test("A4 — idempotent re-open keeps counters+status, refreshes label/meta", () => {
    const s = snap([
      open("a", null, "agent", "old"),
      { type: "node_metric", id: "a", tokensDelta: 100 },
      { type: "node_status", id: "a", status: "stuck", stuck: { reason: "rate_limited" } },
      { type: "node_open", node: { id: "a", parentId: null, kind: "agent", label: "new", meta: { m: "1" } } },
    ])
    const n = s.byId.get("a")
    expect(n?.label).toBe("new") // refreshed
    expect(n?.meta).toEqual({ m: "1" })
    expect(n?.tokens).toBe(100) // counter preserved
    expect(n?.status).toBe("stuck") // lifecycle preserved (re-open is not a reset)
  })

  test("A5 — re-open does NOT duplicate the child link", () => {
    const s = snap([open("p", null, "workflow"), open("c", "p", "agent"), open("c", "p", "agent", "again")])
    expect(s.childIds.get("p")).toEqual(["c"]) // exactly once
  })
})

// ── B. node_status ──────────────────────────────────────────────────────

describe("reduceActivity — node_status", () => {
  test("B1 — status transition applies", () => {
    const s = snap([open("a", null, "agent"), { type: "node_status", id: "a", status: "done" }])
    expect(s.byId.get("a")?.status).toBe("done")
  })

  test("B2 — terminal status stamps endedAt; running does not", () => {
    const done = snap([open("a", null, "agent"), { type: "node_status", id: "a", status: "done", at: 50 }])
    expect(done.byId.get("a")?.endedAt).toBe(50)
    const run = snap([open("b", null, "agent"), { type: "node_status", id: "b", status: "running", at: 50 }])
    expect(run.byId.get("b")?.endedAt).toBeUndefined()
  })

  test("B3 — stuck carries the reason; a later transition CLEARS it", () => {
    const stuckSnap = snap([open("a", null, "agent"), { type: "node_status", id: "a", status: "stuck", stuck: { reason: "waiting_approval", detail: "Write x" } }])
    expect(stuckSnap.byId.get("a")?.stuck).toEqual({ reason: "waiting_approval", detail: "Write x" })
    const clearedSnap = snap([open("a", null, "agent"), { type: "node_status", id: "a", status: "stuck", stuck: { reason: "waiting_approval" } }, { type: "node_status", id: "a", status: "running" }])
    expect(clearedSnap.byId.get("a")?.stuck).toBeUndefined()
  })

  test("B4 — stuck with no reason defaults to 'unknown' (never undefined while stuck)", () => {
    const s = snap([open("a", null, "agent"), { type: "node_status", id: "a", status: "stuck" }])
    expect(s.byId.get("a")?.stuck).toEqual({ reason: "unknown" })
  })

  test("B5 — status for an UNKNOWN id is dropped (NO-THROW, no ghost node)", () => {
    const st = emptyActivityState()
    expect(() => reduceActivity(st, { type: "node_status", id: "ghost", status: "done" })).not.toThrow()
    expect(materialize(st).byId.has("ghost")).toBe(false)
  })

  test("B6 — startedAt stamped on first running transition if open had none", () => {
    const s = snap([open("a", null, "agent"), { type: "node_status", id: "a", status: "running", at: 9 }])
    expect(s.byId.get("a")?.startedAt).toBe(9)
  })
})

// ── C. node_metric ──────────────────────────────────────────────────────

describe("reduceActivity — node_metric", () => {
  test("C1 — deltas accumulate", () => {
    const s = snap([open("a", null, "agent"), { type: "node_metric", id: "a", tokensDelta: 10, toolCallsDelta: 1 }, { type: "node_metric", id: "a", tokensDelta: 5 }])
    expect(s.byId.get("a")?.tokens).toBe(15)
    expect(s.byId.get("a")?.toolCalls).toBe(1)
  })

  test("C2 — metric for unknown id dropped (NO-THROW)", () => {
    const st = emptyActivityState()
    expect(() => reduceActivity(st, { type: "node_metric", id: "ghost", tokensDelta: 5 })).not.toThrow()
    expect(materialize(st).byId.has("ghost")).toBe(false)
  })

  test("C3 — non-finite delta ignored (no NaN poisoning the counter)", () => {
    const s = snap([open("a", null, "agent"), { type: "node_metric", id: "a", tokensDelta: Number.NaN }, { type: "node_metric", id: "a", tokensDelta: Number.POSITIVE_INFINITY }, { type: "node_metric", id: "a", tokensDelta: 7 }])
    expect(s.byId.get("a")?.tokens).toBe(7)
  })

  test("C4 — zero/zero metric is a no-op (node object identity unchanged)", () => {
    const st = reduceAll([open("a", null, "agent")])
    const before = st.nodes.get("a")
    reduceActivity(st, { type: "node_metric", id: "a", tokensDelta: 0, toolCallsDelta: 0 })
    expect(st.nodes.get("a")).toBe(before) // same reference ⇒ truly no-op
  })
})

// ── D. materialize ──────────────────────────────────────────────────────

describe("materialize — tree + aggregate + determinism", () => {
  const fixture: AgentActivityEvent[] = [
    open("run", null, "workflow"),
    open("p1", "run", "phase"),
    open("a1", "p1", "agent"),
    { type: "node_metric", id: "a1", tokensDelta: 100, toolCallsDelta: 3 },
    { type: "node_status", id: "a1", status: "done" },
    open("a2", "p1", "agent"),
    { type: "node_metric", id: "a2", tokensDelta: 50 },
    { type: "node_status", id: "a2", status: "stuck", stuck: { reason: "waiting_approval" } },
  ]

  test("D1 — aggregate: agents excludes phase, counts running/stuck/tokens", () => {
    const s = snap(fixture)
    // agent-kinds: run(workflow) + a1 + a2 = 3 ; p1(phase) excluded
    expect(s.aggregate.agents).toBe(3)
    expect(s.aggregate.running).toBe(1) // only run is still running (a1 done, a2 stuck)
    expect(s.aggregate.stuck).toBe(1) // a2
    expect(s.aggregate.tokens).toBe(150)
    expect(s.aggregate.toolCalls).toBe(3)
  })

  test("D2 — tree nesting: run→p1→[a1,a2]", () => {
    const s = snap(fixture)
    expect(s.roots).toEqual(["run"])
    expect(s.childIds.get("run")).toEqual(["p1"])
    expect(s.childIds.get("p1")).toEqual(["a1", "a2"])
  })

  test("D3 — deterministic: identical event order ⇒ deep-equal snapshots", () => {
    const a = snap(fixture)
    const b = snap(fixture)
    expect([...a.byId.entries()]).toEqual([...b.byId.entries()])
    expect(a.roots).toEqual(b.roots)
    expect(a.aggregate).toEqual(b.aggregate)
  })

  test("D4 — snapshot is a COPY: later reduce does not mutate an earlier snapshot", () => {
    const st = reduceAll([open("a", null, "agent")])
    const s1 = materialize(st)
    reduceActivity(st, { type: "node_metric", id: "a", tokensDelta: 99 })
    expect(s1.byId.get("a")?.tokens).toBe(0) // earlier snapshot frozen
    expect(materialize(st).byId.get("a")?.tokens).toBe(99)
  })

  test("D5 — empty state ⇒ empty snapshot, zero aggregate", () => {
    const s = materialize(emptyActivityState())
    expect(s.roots).toEqual([])
    expect(s.aggregate).toEqual({ agents: 0, running: 0, stuck: 0, tokens: 0, toolCalls: 0 })
  })
})
