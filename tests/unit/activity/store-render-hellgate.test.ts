/**
 * Activity store + render hellgate (jun-15 P0-b).
 *
 *   A. store: emit/snapshot, immutability, NO-THROW                (3)
 *   B. workflow sink: streaming == batch (drift ratchet)           (3)
 *   C. render: header, glyphs, tree indent, why-stuck, +N more     (6)
 */

import { describe, expect, test } from "bun:test"
import {
  type AgentActivityEvent,
  createActivityStore,
  createWorkflowSink,
  materialize,
  reduceAll,
  renderActivity,
  seedStoreFromSnapshot,
  type WorkflowEventLike,
  workflowCloseActivity,
  workflowToActivity,
} from "@/activity"

// ── A. store ──────────────────────────────────────────────────────────────

describe("createActivityStore", () => {
  test("A1 — emit + snapshot reflects folded state", () => {
    const s = createActivityStore()
    s.emit({ type: "node_open", node: { id: "a", parentId: null, kind: "workflow", label: "x" } })
    s.emit({ type: "node_metric", id: "a", tokensDelta: 42 })
    expect(s.snapshot().byId.get("a")?.tokens).toBe(42)
  })

  test("A2 — snapshot is frozen: later emit does not mutate an earlier snapshot", () => {
    const s = createActivityStore()
    s.emit({ type: "node_open", node: { id: "a", parentId: null, kind: "agent", label: "x" } })
    const snap1 = s.snapshot()
    s.emit({ type: "node_metric", id: "a", tokensDelta: 9 })
    expect(snap1.byId.get("a")?.tokens).toBe(0)
    expect(s.snapshot().byId.get("a")?.tokens).toBe(9)
  })

  test("A3 — emitting a status for an unknown id does not throw", () => {
    const s = createActivityStore()
    expect(() => s.emit({ type: "node_status", id: "ghost", status: "done" })).not.toThrow()
  })
})

// ── B. workflow sink: streaming == batch ──────────────────────────────────

describe("createWorkflowSink — streaming equals batch (drift ratchet)", () => {
  const events: WorkflowEventLike[] = [
    { type: "phase_enter", name: "Find" },
    { type: "step_start", id: "f1", label: "find" },
    { type: "step_complete", id: "f1", ok: true },
    { type: "phase_enter", name: "Verify" },
    { type: "step_start", id: "v1", label: "verify" },
    { type: "step_complete", id: "v1", ok: false },
  ]
  const opts = { runId: "run", label: "review" }

  const batchSnap = () =>
    materialize(
      reduceAll([
        ...workflowToActivity(events, opts),
        ...workflowCloseActivity(events, opts, false, 500),
      ]),
    )
  const streamSnap = () => {
    const store = createActivityStore()
    const sink = createWorkflowSink(store, opts)
    for (const e of events) sink.emit(e)
    sink.close(false, 500)
    return store.snapshot()
  }

  test("B1 — same nodes + statuses (the SSOT: one mapping, two entry points)", () => {
    const a = batchSnap()
    const b = streamSnap()
    expect([...b.byId.keys()].sort()).toEqual([...a.byId.keys()].sort())
    for (const id of a.byId.keys()) {
      expect(b.byId.get(id)?.status).toBe(a.byId.get(id)?.status)
    }
  })

  test("B2 — same tree shape + roots", () => {
    const a = batchSnap()
    const b = streamSnap()
    expect(b.roots).toEqual(a.roots)
    expect(b.childIds.get("run")).toEqual(a.childIds.get("run"))
  })

  test("B3 — same aggregate", () => {
    expect(streamSnap().aggregate).toEqual(batchSnap().aggregate)
  })
})

// ── C. render ─────────────────────────────────────────────────────────────

describe("renderActivity", () => {
  const build = (events: Parameters<typeof reduceAll>[0]) => materialize(reduceAll(events))

  test("C1 — empty snapshot ⇒ header + (no active agents)", () => {
    const lines = renderActivity(build([]), { now: 0 })
    expect(lines[0]).toContain("ACTIVITY")
    expect(lines.some((l) => l.includes("no active agents"))).toBe(true)
  })

  test("C2 — header counts agents/running/stuck/tokens", () => {
    const s = build([
      { type: "node_open", node: { id: "a", parentId: null, kind: "agent", label: "x" } },
      { type: "node_metric", id: "a", tokensDelta: 1_200_000 },
      { type: "node_status", id: "a", status: "stuck", stuck: { reason: "rate_limited" } },
    ])
    const header = renderActivity(s, { now: 0 })[0]
    expect(header).toContain("1 agent")
    expect(header).toContain("1 stuck")
    expect(header).toContain("1.2M tok")
  })

  test("C3 — glyphs reflect status", () => {
    const s = build([
      { type: "node_open", node: { id: "d", parentId: null, kind: "agent", label: "done-one" } },
      { type: "node_status", id: "d", status: "done" },
    ])
    const line = renderActivity(s, { now: 0 }).find((l) => l.includes("done-one"))
    expect(line).toContain("✓")
  })

  test("C4 — tree indent: child rows are indented under their parent", () => {
    const s = build([
      { type: "node_open", node: { id: "r", parentId: null, kind: "workflow", label: "run" } },
      { type: "node_open", node: { id: "c", parentId: "r", kind: "agent", label: "child" } },
    ])
    const lines = renderActivity(s, { now: 0 })
    const childLine = lines.find((l) => l.includes("child"))
    expect(childLine?.startsWith("  ")).toBe(true) // indented (depth 1)
    const rootLine = lines.find((l) => l.includes("run") && !l.includes("ACTIVITY"))
    expect(rootLine?.startsWith("  ")).toBe(false) // depth 0, no leading indent
  })

  test("C5 — stuck row shows the why-stuck reason + detail inline (north star)", () => {
    const s = build([
      { type: "node_open", node: { id: "a", parentId: null, kind: "agent", label: "verify:race" } },
      {
        type: "node_status",
        id: "a",
        status: "stuck",
        stuck: { reason: "waiting_approval", detail: "Write src/x.ts" },
      },
    ])
    const line = renderActivity(s, { now: 0 }).find((l) => l.includes("verify:race"))
    expect(line).toContain("🛑")
    expect(line).toContain("waiting approval")
    expect(line).toContain("Write src/x.ts")
  })

  test("C5b — a CONTAINER stuck-by-descendant shows the glyph but NO redundant label", () => {
    const s = build([
      { type: "node_open", node: { id: "r", parentId: null, kind: "workflow", label: "run" } },
      { type: "node_open", node: { id: "c", parentId: "r", kind: "agent", label: "leaf" } },
      { type: "node_status", id: "c", status: "stuck", stuck: { reason: "rate_limited" } },
    ])
    const rootLine = renderActivity(s, { now: 0 }).find((l) => l.includes("run") && !l.includes("ACTIVITY"))
    expect(rootLine).toContain("🛑") // derived stuck glyph
    expect(rootLine).not.toContain("STUCK:") // but no own reason annotation
    const leafLine = renderActivity(s, { now: 0 }).find((l) => l.includes("leaf"))
    expect(leafLine).toContain("STUCK: rate limited") // the real reason is on the leaf
  })

  test("C6 — body past maxRows collapses with a '+N more' footer (no silent truncation)", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      type: "node_open" as const,
      node: { id: `n${i}`, parentId: null, kind: "agent" as const, label: `agent-${i}` },
    }))
    const lines = renderActivity(build(events), { now: 0, maxRows: 4 })
    expect(lines.some((l) => l.includes("+6 more"))).toBe(true)
    expect(lines.filter((l) => l.includes("agent-")).length).toBe(4)
  })

  test("C7 — header surfaces tool-call total when > 0 (design parity)", () => {
    const s = build([
      { type: "node_open", node: { id: "a", parentId: null, kind: "agent", label: "x" } },
      { type: "node_metric", id: "a", toolCallsDelta: 340 },
    ])
    expect(renderActivity(s, { now: 0 })[0]).toContain("340 tool calls")
    // a run with no tool calls does NOT clutter the header
    const none = build([{ type: "node_open", node: { id: "b", parentId: null, kind: "agent", label: "y" } }])
    expect(renderActivity(none, { now: 0 })[0]).not.toContain("tool call")
  })

  test("C8 — idle status renders the 💤 glyph (daemon-between-wakes vocabulary)", () => {
    const s = build([
      { type: "node_open", node: { id: "d", parentId: null, kind: "daemon", label: "indexer" } },
      { type: "node_status", id: "d", status: "idle" },
    ])
    expect(renderActivity(s, { now: 0 }).find((l) => l.includes("indexer"))).toContain("💤")
  })
})

// ── D. seedStoreFromSnapshot — non-mutating view base ──────────────────────

describe("seedStoreFromSnapshot", () => {
  const fixture: AgentActivityEvent[] = [
    { type: "node_open", node: { id: "run", parentId: null, kind: "workflow", label: "review", at: 5 } },
    { type: "node_open", node: { id: "p1", parentId: "run", kind: "phase", label: "Find" } },
    { type: "node_open", node: { id: "a1", parentId: "p1", kind: "agent", label: "find", meta: { m: "1" } } },
    { type: "node_metric", id: "a1", tokensDelta: 120, toolCallsDelta: 3 },
    { type: "node_status", id: "a1", status: "stuck", stuck: { reason: "waiting_approval", detail: "x" } },
    { type: "node_open", node: { id: "a2", parentId: "p1", kind: "agent", label: "verify" } },
    { type: "node_status", id: "a2", status: "done", at: 99 },
  ]

  test("D1 — round-trips a snapshot: byId / roots / childIds / aggregate identical", () => {
    const original = materialize(reduceAll(fixture))
    const seeded = seedStoreFromSnapshot(original).snapshot()
    expect(seeded.roots).toEqual(original.roots)
    expect([...seeded.childIds.entries()]).toEqual([...original.childIds.entries()])
    expect(seeded.aggregate).toEqual(original.aggregate)
    // node-level fidelity: status (incl. DERIVED container), counters, stuck, stamps
    for (const [id, n] of original.byId) {
      const s = seeded.byId.get(id)
      expect(s?.status).toBe(n.status)
      expect(s?.tokens).toBe(n.tokens)
      expect(s?.stuck).toEqual(n.stuck)
      expect(s?.startedAt).toBe(n.startedAt)
      expect(s?.endedAt).toBe(n.endedAt)
    }
  })

  test("D2 — the seed is INDEPENDENT: mutating it does not touch the source store", () => {
    const source = createActivityStore()
    source.emitAll(fixture)
    const before = source.snapshot()
    const view = seedStoreFromSnapshot(source.snapshot())
    view.emit({ type: "node_open", node: { id: "extra", parentId: null, kind: "subagent", label: "live" } })
    // the source is untouched (no "extra" leaked back) — the /activity non-pollution invariant
    expect(source.snapshot().byId.has("extra")).toBe(false)
    expect([...source.snapshot().byId.keys()]).toEqual([...before.byId.keys()])
    expect(view.snapshot().byId.has("extra")).toBe(true)
  })
})
