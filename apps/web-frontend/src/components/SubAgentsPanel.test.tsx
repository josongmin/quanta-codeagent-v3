import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  EMPTY_SUBAGENT_STATE,
  type SubagentMessage,
  type SubagentSpawnMessage,
  type SubagentState,
  subagentReducer,
} from "../ws/subagent-model"
import { SubAgentsPanel, subagentHasContent } from "./SubAgentsPanel"

const spawn = (
  taskId: string,
  parentTaskId: string | undefined,
  depth: number,
  over: Partial<SubagentSpawnMessage> = {},
): SubagentMessage => ({
  type: "subagent_spawn",
  taskId,
  ...(parentTaskId !== undefined ? { parentTaskId } : {}),
  depth,
  description: `task ${taskId}`,
  agentType: "explorer",
  at: 0,
  emittedAt: 0,
  ...over,
})

const status = (
  taskId: string,
  s: "running" | "completed" | "failed" | "stopped",
): SubagentMessage => ({ type: "subagent_status", taskId, status: s, at: 0, emittedAt: 0 })

const fold = (msgs: SubagentMessage[]): SubagentState =>
  msgs.reduce((st, msg) => subagentReducer(st, { type: "message", msg }), EMPTY_SUBAGENT_STATE)

describe("SubAgentsPanel", () => {
  it("renders nothing for the empty model (default-OFF)", () => {
    expect(renderToStaticMarkup(<SubAgentsPanel state={EMPTY_SUBAGENT_STATE} />)).toBe("")
    expect(subagentHasContent(EMPTY_SUBAGENT_STATE)).toBe(false)
  })

  it("renders the spawn TREE with the child indented under its parent", () => {
    const st = fold([spawn("root", undefined, 0), spawn("child", "root", 1)])
    const markup = renderToStaticMarkup(<SubAgentsPanel state={st} />)
    expect(markup).toContain('data-testid="subagents-panel"')
    // both rows present
    expect(markup).toContain('data-task-id="root"')
    expect(markup).toContain('data-task-id="child"')
    // the child is INDENTED (depth 1 ⇒ 12px) — proving the tree nesting drives
    // the render, not a flat list.
    expect(markup).toContain("padding-left:12px")
  })

  it("partitions Active vs Done sections by terminal status", () => {
    const st = fold([
      spawn("a", undefined, 0),
      spawn("b", undefined, 0),
      status("a", "completed"),
      status("b", "running"),
    ])
    const markup = renderToStaticMarkup(<SubAgentsPanel state={st} />)
    expect(markup).toContain('data-testid="subagents-active"')
    expect(markup).toContain('data-testid="subagents-done"')
    // the working node carries the "working" badge; the completed one "done".
    expect(markup).toContain('data-status="working"')
    expect(markup).toContain('data-status="done"')
  })

  it("renders a failed badge for a failed subagent", () => {
    const st = fold([spawn("x", undefined, 0), status("x", "failed")])
    const markup = renderToStaticMarkup(<SubAgentsPanel state={st} />)
    expect(markup).toContain('data-status="failed"')
  })
})
