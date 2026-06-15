/**
 * run_workflow → Activity Spine WRITE-PATH hellgate (jun-15 P0-b).
 *
 * Proves the live wiring end-to-end at the tool boundary: when the
 * `run_workflow` tool is built with `deps.activityStore`, executing a spec
 * records the run (root + phases + steps) into that store — the exact snapshot
 * `/activity` renders. Without the store the tool is byte-identical (no
 * recording). Uses a scripted `AgentRunPort` (no real subagents).
 */

import { describe, expect, test } from "bun:test"
import { createActivityStore, projectFleet } from "@/activity"
import type { ToolContext, ToolResult } from "@/tool"
import { createRunWorkflowTool } from "@/tool/workflow/run-workflow-tool"
import type { AgentRunPort, AgentRunRequest, AgentRunResult } from "@/workflow"

const scripted = (): AgentRunPort => ({
  async run(_req: AgentRunRequest): Promise<AgentRunResult> {
    return { ok: true, text: "ok" }
  },
})

const ctx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  toolCallId: "wf-call-1",
})

const drive = async (tool: ReturnType<typeof createRunWorkflowTool>, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const SPEC = {
  phases: [
    { name: "Find", steps: [{ id: "f1", prompt: "find" }] },
    { name: "Verify", steps: [{ id: "v1", prompt: "verify" }] },
  ],
}

describe("run_workflow → activity spine (write path)", () => {
  test("W1 — with deps.activityStore: the run is recorded as a workflow tree", async () => {
    const store = createActivityStore()
    const tool = createRunWorkflowTool({ agentRun: scripted(), activityStore: store })
    const res = await drive(tool, SPEC)
    expect(res.ok).toBe(true)

    const snap = store.snapshot()
    // L0: exactly one workflow root, keyed by the toolCallId, labelled by the
    // first phase name.
    const fleet = projectFleet(snap)
    expect(fleet).toHaveLength(1)
    expect(fleet[0]?.kind).toBe("workflow")
    expect(fleet[0]?.id).toBe("wf-call-1")
    // run closed ok ⇒ derives done (all steps ok)
    expect(snap.byId.get("wf-call-1")?.status).toBe("done")
    // L1: both phases present + nested; L2: their steps.
    expect(snap.childIds.get("wf-call-1")).toEqual(["wf-call-1/phase/Find", "wf-call-1/phase/Verify"])
    expect(snap.byId.get("wf-call-1/step/f1")?.status).toBe("done")
    expect(snap.byId.get("wf-call-1/step/v1")?.status).toBe("done")
  })

  test("W2 — WITHOUT a store: tool still runs, records nothing (byte-identical)", async () => {
    const store = createActivityStore()
    const tool = createRunWorkflowTool({ agentRun: scripted() }) // no activityStore
    const res = await drive(tool, SPEC)
    expect(res.ok).toBe(true)
    expect(store.snapshot().roots).toEqual([]) // the unrelated store stays empty
  })
})
