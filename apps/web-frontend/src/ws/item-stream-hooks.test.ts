/**
 * S2 (T01) — item-stream reducer + kind-filter unit tests (node env, no DOM).
 * Mirrors `canvas-artifact-hooks.test.ts` / `agent-state-hooks` reducer tests:
 * the reducer is exported so the fold semantics + FIFO cap are unit-tested
 * directly, and the per-kind guards prove routing exclusivity.
 */

import { describe, expect, it } from "vitest"
import type {
  AgentStateMessage,
  ItemCompletedMessage,
  ItemDeltaMessage,
  ItemStartedMessage,
  ToolProgressMessage,
} from "../types/protocol"
import {
  EMPTY_ITEM_STREAM,
  ITEM_STREAM_CAP,
  isItemCompletedMsg,
  isItemDeltaMsg,
  isItemStartedMsg,
  itemStreamReducer,
} from "./item-stream-hooks"

const started = (id: string, index = 0, type = "subagent"): ItemStartedMessage => ({
  kind: "item.started",
  itemId: id,
  itemType: type,
  itemIndex: index,
  emittedAt: 0,
})
const delta = (id: string, d: string, type = "subagent"): ItemDeltaMessage => ({
  kind: "item.delta",
  itemId: id,
  itemType: type,
  deltaKind: "text",
  delta: d,
  emittedAt: 0,
})
const completed = (id: string, text?: string, type = "subagent"): ItemCompletedMessage => ({
  kind: "item.completed",
  itemId: id,
  itemType: type,
  ...(text !== undefined ? { text } : {}),
  emittedAt: 0,
})
const msg = (m: AgentStateMessage): { type: "message"; msg: AgentStateMessage } => ({
  type: "message",
  msg: m,
})

describe("S2 item-stream kind filter", () => {
  it("each guard narrows exactly one item kind (routing exclusivity)", () => {
    const s: AgentStateMessage = started("i1")
    expect(isItemStartedMsg(s)).toBe(true)
    expect(isItemDeltaMsg(s)).toBe(false)
    expect(isItemCompletedMsg(s)).toBe(false)
    const d: AgentStateMessage = delta("i1", "x")
    expect(isItemDeltaMsg(d)).toBe(true)
    expect(isItemStartedMsg(d)).toBe(false)
  })

  it("a non-item agent-state kind matches none of the guards", () => {
    const progress: ToolProgressMessage = {
      kind: "tool.progress",
      toolCallId: "t1",
      toolName: "bash",
      message: "running",
      emittedAt: 0,
    }
    expect(isItemStartedMsg(progress)).toBe(false)
    expect(isItemDeltaMsg(progress)).toBe(false)
    expect(isItemCompletedMsg(progress)).toBe(false)
  })
})

describe("S2 itemStreamReducer", () => {
  it("started → running row; delta appends text; completed marks done", () => {
    let s = itemStreamReducer(EMPTY_ITEM_STREAM, msg(started("i1", 0)))
    expect(s.items.get("i1")?.status).toBe("running")
    s = itemStreamReducer(s, msg(delta("i1", "Hello ")))
    s = itemStreamReducer(s, msg(delta("i1", "world")))
    expect(s.items.get("i1")?.text).toBe("Hello world")
    expect(s.items.get("i1")?.status).toBe("running")
    s = itemStreamReducer(s, msg(completed("i1")))
    expect(s.items.get("i1")?.status).toBe("completed")
    // Accumulated text is retained when completed carries no final text.
    expect(s.items.get("i1")?.text).toBe("Hello world")
  })

  it("completed adopts the final text when present", () => {
    let s = itemStreamReducer(EMPTY_ITEM_STREAM, msg(started("i1")))
    s = itemStreamReducer(s, msg(delta("i1", "partial")))
    s = itemStreamReducer(s, msg(completed("i1", "FINAL")))
    expect(s.items.get("i1")?.text).toBe("FINAL")
  })

  it("is forward-tolerant: a delta for an unseen item creates a running row", () => {
    const s = itemStreamReducer(EMPTY_ITEM_STREAM, msg(delta("i9", "orphan")))
    expect(s.items.get("i9")?.status).toBe("running")
    expect(s.items.get("i9")?.text).toBe("orphan")
  })

  it("keeps distinct items insertion-ordered by id (latest-wins per id)", () => {
    let s = itemStreamReducer(EMPTY_ITEM_STREAM, msg(started("a", 0)))
    s = itemStreamReducer(s, msg(started("b", 1)))
    expect([...s.items.keys()]).toEqual(["a", "b"])
    expect(s.items.size).toBe(2)
  })

  it("a non-item message returns the prior state BY REFERENCE (idle no-op)", () => {
    const s0 = itemStreamReducer(EMPTY_ITEM_STREAM, msg(started("i1")))
    const progress: ToolProgressMessage = {
      kind: "tool.progress",
      toolCallId: "t1",
      toolName: "bash",
      message: "x",
      emittedAt: 0,
    }
    const s1 = itemStreamReducer(s0, msg(progress))
    expect(s1).toBe(s0) // reference-identical (no re-render churn)
  })

  it("reset clears the stream", () => {
    let s = itemStreamReducer(EMPTY_ITEM_STREAM, msg(started("i1")))
    s = itemStreamReducer(s, { type: "reset" })
    expect(s.items.size).toBe(0)
  })

  it("FIFO-caps at ITEM_STREAM_CAP so a pathological session can't grow unbounded", () => {
    let s = EMPTY_ITEM_STREAM
    for (let i = 0; i < ITEM_STREAM_CAP + 40; i++) {
      s = itemStreamReducer(s, msg(started(`i-${i}`, i)))
    }
    expect(s.items.size).toBe(ITEM_STREAM_CAP)
    expect(s.items.has(`i-${ITEM_STREAM_CAP + 39}`)).toBe(true) // recent retained
    expect(s.items.has("i-0")).toBe(false) // oldest evicted
  })
})
