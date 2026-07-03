import { describe, expect, it } from "vitest"
import type { CanvasMessage, ContextUsageMessage, ToolDiffMessage } from "../types/protocol"
import {
  type CanvasSource,
  isContextUsageMessage,
  isToolDiffMessage,
  TOOL_DIFFS_CAP,
  toolDiffsReducer,
} from "./canvas-hooks"

const diff = (toolCallId: string, additions: number): ToolDiffMessage => ({
  kind: "tool.diff",
  toolCallId,
  lines: [],
  additions,
  deletions: 0,
  emittedAt: 0,
})

const usageMsg = (total: number): ContextUsageMessage => ({
  kind: "context.usage",
  segments: [],
  total,
  max: 100,
  emittedAt: 0,
})

// The kind-filter the hooks route on is now a SINGLE exported predicate (was
// re-implemented inline in this test). Test the load-bearing helper directly so
// a drift in the routing narrows here, not in a copy.
describe("canvas kind filters", () => {
  it("isToolDiffMessage narrows tool.diff only", () => {
    const td: CanvasMessage = diff("t1", 1)
    const cu: CanvasMessage = usageMsg(5)
    expect(isToolDiffMessage(td)).toBe(true)
    expect(isToolDiffMessage(cu)).toBe(false)
  })

  it("isContextUsageMessage narrows context.usage only", () => {
    const td: CanvasMessage = diff("t1", 1)
    const cu: CanvasMessage = usageMsg(5)
    expect(isContextUsageMessage(cu)).toBe(true)
    expect(isContextUsageMessage(td)).toBe(false)
  })
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

// P3 (memory backstop): the latest-wins Map is FIFO-capped so a pathological
// session with thousands of distinct toolCallIds cannot grow it unbounded
// (each diff retains its full lines[]). The cap is a BACKSTOP (256), not a
// tuned value — it never evicts anything in a normal pane.
describe("toolDiffsReducer FIFO cap (P3 memory backstop)", () => {
  it("bounds the Map size at TOOL_DIFFS_CAP even with cap+ distinct tool calls", () => {
    let state: ReadonlyMap<string, ToolDiffMessage> = new Map()
    const overflow = TOOL_DIFFS_CAP + 50
    for (let i = 0; i < overflow; i += 1) {
      state = toolDiffsReducer(state, { type: "message", msg: diff(`t${i}`, i) })
    }
    // Size is clamped to the cap, not the (cap+50) distinct ids fed in.
    expect(state.size).toBe(TOOL_DIFFS_CAP)
  })

  it("retains the RECENT window and evicts the OLDEST (FIFO)", () => {
    let state: ReadonlyMap<string, ToolDiffMessage> = new Map()
    const overflow = TOOL_DIFFS_CAP + 50
    for (let i = 0; i < overflow; i += 1) {
      state = toolDiffsReducer(state, { type: "message", msg: diff(`t${i}`, i) })
    }
    // The oldest `overflow - cap` (= 50) entries (t0..t49) were evicted; the
    // most-recent `cap` entries (t50..t305 — what a surface renders) are kept.
    const evicted = overflow - TOOL_DIFFS_CAP // 50
    expect(state.has("t0")).toBe(false)
    expect(state.has(`t${evicted - 1}`)).toBe(false) // last evicted (t49)
    expect(state.has(`t${evicted}`)).toBe(true) // oldest surviving (t50)
    expect(state.has(`t${overflow - 1}`)).toBe(true) // newest
    expect(state.get(`t${overflow - 1}`)?.additions).toBe(overflow - 1)
  })

  it("latest-wins on an EXISTING id does not evict and does not reorder (recent stays recent)", () => {
    let state: ReadonlyMap<string, ToolDiffMessage> = new Map()
    // Fill exactly to the cap.
    for (let i = 0; i < TOOL_DIFFS_CAP; i += 1) {
      state = toolDiffsReducer(state, { type: "message", msg: diff(`t${i}`, i) })
    }
    expect(state.size).toBe(TOOL_DIFFS_CAP)
    // Re-touch the OLDEST id (t0). A Map.set on an existing key updates in place
    // WITHOUT moving it, so size stays at cap and nothing is evicted.
    state = toolDiffsReducer(state, { type: "message", msg: diff("t0", 777) })
    expect(state.size).toBe(TOOL_DIFFS_CAP)
    expect(state.get("t0")?.additions).toBe(777) // latest-wins preserved
    // Now a genuinely NEW id pushes over the cap ⇒ the still-oldest (t0, since
    // re-set didn't reorder it) is the one evicted.
    state = toolDiffsReducer(state, { type: "message", msg: diff("tNew", 1) })
    expect(state.size).toBe(TOOL_DIFFS_CAP)
    expect(state.has("t0")).toBe(false)
    expect(state.has("tNew")).toBe(true)
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
    let state: ReadonlyMap<string, ToolDiffMessage> = new Map<string, ToolDiffMessage>()
    const off = source.subscribe((msg) => {
      if (isToolDiffMessage(msg)) state = toolDiffsReducer(state, { type: "message", msg })
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
      if (isContextUsageMessage(msg)) latest = msg
    })
    emit({ kind: "context.usage", segments: [], total: 1, max: 10, emittedAt: 1 })
    emit({ kind: "context.usage", segments: [], total: 2, max: 10, emittedAt: 2 })
    expect((latest as ContextUsageMessage | null)?.total).toBe(2)
  })
})
