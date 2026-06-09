import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { AgentStatePlan } from "../types/protocol"
import { PlanPanel } from "./PlanPanel"

const plan: AgentStatePlan = {
  id: "plan-1",
  name: "Ship the agent-state channel",
  version: 3,
  todos: [
    { id: "t1", title: "Build the codec", status: "completed" },
    { id: "t2", title: "Wire the daemon sink", status: "in_progress" },
    { id: "t3", title: "Mount the panel", status: "pending" },
    { id: "t4", title: "Awaiting review", status: "blocked" },
    { id: "t5", title: "Drop the spike", status: "cancelled" },
  ],
}

describe("PlanPanel", () => {
  it("renders the plan name, version, and every todo title", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={plan} />)
    // Name + version surfaced.
    expect(markup).toContain("Ship the agent-state channel")
    expect(markup).toContain("v3")
    // Every todo title rendered.
    expect(markup).toContain("Build the codec")
    expect(markup).toContain("Wire the daemon sink")
    expect(markup).toContain("Mount the panel")
    expect(markup).toContain("Awaiting review")
    expect(markup).toContain("Drop the spike")
  })

  it("tags each todo row with its status so the per-status icon is selectable", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={plan} />)
    // The five distinct statuses each surface a data-status hook (one per todo).
    for (const status of ["completed", "in_progress", "pending", "blocked", "cancelled"]) {
      expect(markup).toContain(`data-status="${status}"`)
    }
  })

  it("renders an empty-todos plan without a row list", () => {
    const markup = renderToStaticMarkup(
      <PlanPanel plan={{ id: "p", name: "Empty plan", version: 1, todos: [] }} />,
    )
    expect(markup).toContain("Empty plan")
    expect(markup).toContain("No todos.")
    expect(markup).not.toContain("data-status")
  })

  it("SELF-HIDES: a null plan renders nothing", () => {
    const markup = renderToStaticMarkup(<PlanPanel plan={null} />)
    expect(markup).toBe("")
  })
})
