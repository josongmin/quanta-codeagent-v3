import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { AgentStatePlan } from "../types/protocol"
import { PlanPanel } from "./PlanPanel"

/** A/B/C DAG: B depends on A, C depends on A+B. */
const graphPlan: AgentStatePlan = {
  id: "plan-dag",
  name: "Ship the DAG view",
  version: 4,
  todos: [
    { id: "A", title: "task A", status: "completed" },
    { id: "B", title: "task B", status: "in_progress", dependencies: ["A"] },
    { id: "C", title: "task C", status: "pending", dependencies: ["A", "B"] },
  ],
}

describe("PlanPanel — RFC12-1 graph toggle", () => {
  it("GATE-OFF (graphEnabled unset): flat list only, NO toggle rendered", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={graphPlan} />)
    // Flat list still there.
    expect(markup).toContain("task A")
    expect(markup).toContain('data-status="in_progress"')
    // No toggle control, no mermaid host.
    expect(markup).not.toContain('data-testid="plan-view-toggle"')
    expect(markup).not.toContain("data-mermaid-source")
  })

  it("GATE-ON default view: renders the flat list + a list⇄graph toggle", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={graphPlan} graphEnabled />)
    expect(markup).toContain('data-testid="plan-view-toggle"')
    // Default view is the list (byte-shape: still shows a status row).
    expect(markup).toContain('data-status="completed"')
  })

  it("GATE-ON + initialView=graph: renders the projected mermaid DAG", () => {
    const markup = renderToStaticMarkup(
      <PlanPanel plan={graphPlan} graphEnabled initialView="graph" />,
    )
    // The mermaid host carries the projected source (via MermaidDiagram source prop).
    expect(markup).toContain("data-mermaid-source")
    expect(markup).toContain("graph TD")
    // The right DAG edges, projected from `dependencies`.
    expect(markup).toContain("A --&gt; B")
    expect(markup).toContain("A --&gt; C")
    expect(markup).toContain("B --&gt; C")
    // Node labels present.
    expect(markup).toContain("task A")
  })

  it("GATE-ON graph view is NON-VACUOUS: an edge-free plan projects no arrows", () => {
    const flat: AgentStatePlan = {
      id: "p",
      name: "flat",
      version: 1,
      todos: [
        { id: "A", title: "a", status: "pending" },
        { id: "B", title: "b", status: "pending" },
      ],
    }
    const markup = renderToStaticMarkup(<PlanPanel plan={flat} graphEnabled initialView="graph" />)
    expect(markup).toContain("graph TD")
    expect(markup).not.toContain("--&gt;")
  })

  it("SELF-HIDES: null plan renders nothing even with graphEnabled", () => {
    expect(renderToStaticMarkup(<PlanPanel plan={null} graphEnabled />)).toBe("")
  })
})
