import { describe, expect, it } from "vitest"
import {
  activeNodes,
  buildSubagentTree,
  doneNodes,
  EMPTY_SUBAGENT_STATE,
  nodeChildren,
  type SubagentMessage,
  type SubagentSpawnMessage,
  type SubagentStatusMessage,
  subagentReducer,
} from "./subagent-model"

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
  over: Partial<SubagentStatusMessage> = {},
): SubagentMessage => ({
  type: "subagent_status",
  taskId,
  status: s,
  at: 0,
  emittedAt: 0,
  ...over,
})

const fold = (msgs: SubagentMessage[]) =>
  msgs.reduce((st, msg) => subagentReducer(st, { type: "message", msg }), EMPTY_SUBAGENT_STATE)

describe("subagent-model reducer", () => {
  it("a spawn adds a node; a status updates it", () => {
    const st = fold([
      spawn("a", undefined, 0),
      status("a", "completed", { finalTextPreview: "done" }),
    ])
    const node = st.nodes.get("a")
    expect(node).toBeDefined()
    expect(node?.status).toBe("completed")
    expect(node?.description).toBe("task a")
    expect(node?.finalTextPreview).toBe("done")
    expect(node?.agentType).toBe("explorer")
  })

  it("nests a child under its parent via parentTaskId (the TREE)", () => {
    const st = fold([spawn("root", undefined, 0), spawn("child", "root", 1)])
    const roots = buildSubagentTree(st)
    // The tree has ONE root; the child is nested under it (NOT a second root).
    expect(roots.map((r) => r.node.taskId)).toEqual(["root"])
    expect(roots[0]?.children.map((c) => c.node.taskId)).toEqual(["child"])
    // drill-in: children lookup returns the child node
    expect(nodeChildren(st, "root").map((n) => n.taskId)).toEqual(["child"])
  })

  it("partitions Active vs Done by terminal status", () => {
    const st = fold([
      spawn("a", undefined, 0),
      spawn("b", undefined, 0),
      status("a", "completed"),
      status("b", "running"),
    ])
    expect(activeNodes(st).map((n) => n.taskId)).toEqual(["b"])
    expect(doneNodes(st).map((n) => n.taskId)).toEqual(["a"])
  })

  it("MUTATION ignore parentTaskId ⇒ tree flattens (child becomes a 2nd root)", () => {
    // The tree nesting is LOAD-BEARING on parentTaskId. This pins that a child
    // with a valid parent is NOT a root: were the reducer/tree to drop
    // parentTaskId, both would surface as roots (a flat list) and this fails.
    const nested = fold([spawn("root", undefined, 0), spawn("child", "root", 1)])
    expect(buildSubagentTree(nested).map((r) => r.node.taskId)).toEqual(["root"])

    // Control: the SAME two spawns WITHOUT the parent edge DO flatten to two
    // roots — proving the assertion above is discriminating, not vacuous.
    const flat = fold([spawn("root", undefined, 0), spawn("child", undefined, 0)])
    expect(buildSubagentTree(flat).map((r) => r.node.taskId)).toEqual(["root", "child"])
  })

  it("a status before its spawn is retained and applied when the spawn lands", () => {
    // Out-of-order delivery: status can race ahead of spawn.
    const st = fold([status("late", "failed", { error: "boom" }), spawn("late", undefined, 0)])
    const node = st.nodes.get("late")
    expect(node?.status).toBe("failed")
    expect(node?.error).toBe("boom")
    expect(node?.description).toBe("task late")
  })
})
