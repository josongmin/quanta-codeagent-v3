/**
 * RFC12-1 hellgate — `plan-to-mermaid` pure projector.
 *
 * The agent already derives the DAG edges every turn (`blockedBy :=
 * dependencies`, RFC07-3); this projector turns a plan's task set into a
 * mermaid `graph TD` flowchart string — one node per todo, one edge per
 * dependency — WITHOUT a new protocol kind or store.
 *
 * FRONT-DOOR: feed the RFC07-3 task view (id/title/status/blockedBy) for the
 * `A`, `B→A`, `C→A+B` fixture and assert the emitted mermaid carries the right
 * nodes + the right edges (dep --> id), deduped + deterministically ordered.
 *
 * RED-ON-INJECTION: if the projector stops emitting edges (drops the
 * `blockedBy` walk) the graph loses every `-->` and the edge assertions go RED.
 */
import { describe, expect, test } from "bun:test"
import { type MermaidPlanNode, planToMermaid } from "../../../../src/tool/plan/plan-to-mermaid"

/** A/B/C fixture: A has no deps, B depends on A, C depends on A+B. */
const NODES: readonly MermaidPlanNode[] = [
  { id: "A", title: "task A", status: "completed", blockedBy: [] },
  { id: "B", title: "task B", status: "in_progress", blockedBy: ["A"] },
  { id: "C", title: "task C", status: "pending", blockedBy: ["A", "B"] },
]

describe("planToMermaid — pure DAG projector", () => {
  test("emits a `graph TD` header", () => {
    expect(planToMermaid(NODES).startsWith("graph TD")).toBe(true)
  })

  test("one node declaration per todo, id + escaped title label", () => {
    const out = planToMermaid(NODES)
    expect(out).toContain('A["task A"]')
    expect(out).toContain('B["task B"]')
    expect(out).toContain('C["task C"]')
  })

  test("one edge `dep --> id` per dependency (the RFC07-3 blockedBy edge)", () => {
    const out = planToMermaid(NODES)
    // B depends on A ⇒ A --> B ; C depends on A and B ⇒ A --> C, B --> C.
    expect(out).toContain("A --> B")
    expect(out).toContain("A --> C")
    expect(out).toContain("B --> C")
    // No phantom edges: exactly 3 arrows for this fixture.
    expect(out.match(/-->/g)?.length).toBe(3)
  })

  test("status drives a per-node class line (completed/in_progress/pending)", () => {
    const out = planToMermaid(NODES)
    expect(out).toContain("class A completed")
    expect(out).toContain("class B in_progress")
    expect(out).toContain("class C pending")
  })

  test("deterministic: identical input ⇒ byte-identical output regardless of array order", () => {
    const shuffled = [NODES[2], NODES[0], NODES[1]] as MermaidPlanNode[]
    expect(planToMermaid(shuffled)).toBe(planToMermaid(NODES))
  })

  test("dedups a duplicated dependency edge (mermaid-safe, no double arrow)", () => {
    const dup: MermaidPlanNode[] = [
      { id: "A", title: "a", status: "pending", blockedBy: [] },
      { id: "B", title: "b", status: "pending", blockedBy: ["A", "A"] },
    ]
    expect(planToMermaid(dup).match(/A --> B/g)?.length).toBe(1)
  })

  test("cycle/back-edge safe: a 2-cycle still emits both edges without throwing", () => {
    const cyc: MermaidPlanNode[] = [
      { id: "A", title: "a", status: "pending", blockedBy: ["B"] },
      { id: "B", title: "b", status: "pending", blockedBy: ["A"] },
    ]
    const out = planToMermaid(cyc)
    expect(out).toContain("B --> A")
    expect(out).toContain("A --> B")
  })

  test("escapes double-quotes in a title so the label string stays well-formed", () => {
    const q: MermaidPlanNode[] = [
      { id: "A", title: 'a "quoted" title', status: "pending", blockedBy: [] },
    ]
    const out = planToMermaid(q)
    // A raw `"` inside the label would break the `id["..."]` node; it must be
    // rendered via the mermaid HTML entity so the bracket stays balanced.
    expect(out).not.toContain('A["a "quoted" title"]')
    expect(out).toContain("#quot;")
  })

  test("dangling dep (points at a non-existent node) is dropped, not a phantom edge", () => {
    const dangle: MermaidPlanNode[] = [
      { id: "A", title: "a", status: "pending", blockedBy: ["GHOST"] },
    ]
    const out = planToMermaid(dangle)
    expect(out).not.toContain("GHOST")
    expect(out).not.toContain("-->")
  })

  test("empty plan ⇒ header only, no nodes/edges", () => {
    const out = planToMermaid([])
    expect(out).toBe("graph TD")
  })
})
