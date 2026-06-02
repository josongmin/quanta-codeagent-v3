import { describe, expect, it } from "vitest"
import type { ContextUsageMessage, ToolDiffMessage } from "../types/protocol"
import { type CanvasSource, toolDiffsReducer } from "./canvas-hooks"

const diff = (toolCallId: string, additions: number): ToolDiffMessage => ({
  kind: "tool.diff",
  toolCallId,
  lines: [],
  additions,
  deletions: 0,
  emittedAt: 0,
})

describe("toolDiffsReducer", () => {
  it("adds a frame keyed by toolCallId", () => {
    const next = toolDiffsReducer(new Map(), { type: "message", msg: diff("t1", 1) })
    expect(next.get("t1")?.additions).toBe(1)
  })

  it("latest-wins on a repeated toolCallId", () => {
    let state = toolDiffsReducer(new Map(), { type: "message", msg: diff("t1", 1) })
    state = toolDiffsReducer(state, { type: "message", msg: diff("t1", 9) })
    expect(state.size).toBe(1)
    expect(state.get("t1")?.additions).toBe(9)
  })

  it("keeps distinct tool calls separate", () => {
    let state = toolDiffsReducer(new Map(), { type: "message", msg: diff("t1", 1) })
    state = toolDiffsReducer(state, { type: "message", msg: diff("t2", 2) })
    expect(state.size).toBe(2)
  })

  it("reset clears", () => {
    const state = toolDiffsReducer(new Map(), { type: "message", msg: diff("t1", 1) })
    expect(toolDiffsReducer(state, { type: "reset" }).size).toBe(0)
  })
})

// A tiny manual harness exercising the SAME routing the hooks apply, without a
// React renderer (the test env is `node`, no DOM). Proves a CanvasSource feeds
// only the matching message kind into each consumer.
describe("CanvasSource routing", () => {
  const makeSource = () => {
    let handler: ((m: ToolDiffMessage | ContextUsageMessage) => void) | null = null
    const source: CanvasSource = {
      subscribe(h) {
        handler = h
        return () => {
          handler = null
        }
      },
    }
    return { source, emit: (m: ToolDiffMessage | ContextUsageMessage) => handler?.(m) }
  }

  it("routes tool.diff to the diff reducer and ignores usage frames there", () => {
    const { source, emit } = makeSource()
    let state = new Map<string, ToolDiffMessage>()
    const off = source.subscribe((msg) => {
      if (msg.kind === "tool.diff") state = toolDiffsReducer(state, { type: "message", msg })
    })
    const usage: ContextUsageMessage = {
      kind: "context.usage",
      segments: [],
      total: 0,
      max: 0,
      emittedAt: 0,
    }
    emit(usage)
    emit(diff("t1", 3))
    off()
    expect(state.size).toBe(1)
    expect(state.get("t1")?.additions).toBe(3)
  })

  it("latest usage frame wins for a usage consumer", () => {
    const { source, emit } = makeSource()
    let latest: ContextUsageMessage | null = null
    source.subscribe((msg) => {
      if (msg.kind === "context.usage") latest = msg
    })
    emit({ kind: "context.usage", segments: [], total: 1, max: 10, emittedAt: 1 })
    emit({ kind: "context.usage", segments: [], total: 2, max: 10, emittedAt: 2 })
    expect((latest as ContextUsageMessage | null)?.total).toBe(2)
  })
})
