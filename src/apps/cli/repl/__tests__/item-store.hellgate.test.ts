/**
 * S2 (jul-03) hellgate — the bounded ItemStore that makes `QUANTA_ITEM_STREAM`
 * produce VISIBLE `/activity` rows (was `logger.debug`-only).
 *
 * The store is BOTH an ItemStreamSink (the fleet pump captures into it) AND a
 * bounded snapshot source. These pin: capture retains lifecycle state per id,
 * `completed` REPLACES `started` for the same id (latest-wins, not a growing
 * log), the ring is bounded (oldest first-seen id evicted), deltas are dropped,
 * and the renderer produces scannable rows + a byte-identical "" for empty.
 */

import { describe, expect, test } from "bun:test"
import type { ItemStreamCore } from "@/shared"
import { createItemStore, renderItemSection } from "../item-store"

const started = (id: string, index = 0): ItemStreamCore => ({
  phase: "started",
  itemId: id,
  itemType: "subagent",
  index,
})
const completed = (id: string, text?: string): ItemStreamCore => ({
  phase: "completed",
  itemId: id,
  itemType: "subagent",
  ...(text !== undefined ? { text } : {}),
})

describe("ItemStore — capture + snapshot", () => {
  test("retains one row per itemId; completed REPLACES started (latest-wins)", () => {
    const store = createItemStore()
    store.capture(started("item-subagent-a"))
    store.capture(started("item-subagent-b"))
    expect(store.size()).toBe(2)
    // completed for 'a' replaces its started (same slot, not a 3rd row)
    store.capture(completed("item-subagent-a", JSON.stringify({ status: "done" })))
    expect(store.size()).toBe(2)
    const snap = store.snapshot()
    // first-seen order preserved
    expect(snap.map((r) => r.itemId)).toEqual(["item-subagent-a", "item-subagent-b"])
    expect(snap[0]?.phase).toBe("completed")
    expect(snap[0]?.text).toContain("done")
    expect(snap[1]?.phase).toBe("started")
  })

  test("delta cores are dropped (transient — not retained)", () => {
    const store = createItemStore()
    store.capture({
      phase: "delta",
      itemId: "item-subagent-x",
      itemType: "subagent",
      deltaKind: "subagent.progress",
      delta: "…",
    })
    expect(store.size()).toBe(0)
  })

  test("bounded ring — oldest first-seen id evicted past the cap", () => {
    const store = createItemStore(2)
    store.capture(started("a"))
    store.capture(started("b"))
    store.capture(started("c")) // evicts 'a'
    expect(store.snapshot().map((r) => r.itemId)).toEqual(["b", "c"])
  })
})

describe("renderItemSection", () => {
  test("empty snapshot ⇒ '' (byte-identical: caller appends nothing)", () => {
    expect(renderItemSection([])).toBe("")
  })

  test("renders a scannable header + one row per item with drilldown detail", () => {
    const out = renderItemSection([
      { itemId: "item-subagent-a", itemType: "subagent", phase: "started" },
      {
        itemId: "item-subagent-b",
        itemType: "subagent",
        phase: "completed",
        text: JSON.stringify({ status: "done", turns: 5 }),
      },
    ])
    expect(out).toContain("Subagent items — 2 rows")
    expect(out).toContain("item-subagent-a")
    expect(out).toContain("running")
    expect(out).toContain("done")
    expect(out).toContain("5 turns")
  })

  test("a non-JSON completed body never throws (falls back to the phase default)", () => {
    const out = renderItemSection([
      { itemId: "item-subagent-z", itemType: "subagent", phase: "completed", text: "not json" },
    ])
    expect(out).toContain("item-subagent-z")
    expect(out).toContain("settled")
  })
})
