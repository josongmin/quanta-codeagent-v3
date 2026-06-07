/**
 * Hellgate — item lifecycle projector (gap-other-agent GAP 10).
 *
 * Codex emits per-output-item lifecycle (ItemStarted/Updated/Completed) so a UI
 * can show granular progress. quanta's stream is turn-granular. This is the
 * essential PURE projector: fed the existing AgentEvent stream it emits item
 * lifecycle events ALONGSIDE — additive, opt-in (QUANTA_ITEM_LIFECYCLE).
 *
 * Model: an assistant text RUN is one "text" item (started on first delta,
 * updated per delta, completed when a non-text event / turn boundary arrives);
 * each tool is a "tool" item (started at tool_call, completed at its tool_result).
 *
 * Invariants:
 *   1. text run ⇒ item_started(text) then item_updated per delta.
 *   2. a tool_call closes the open text item, opens a tool item; its tool_result
 *      completes that tool item (matched by id).
 *   3. turn_start / done close any open text item.
 *   4. stable, deterministic ids + monotonic index; unrelated events ⇒ [].
 *   5. itemLifecycleEnabled is default-OFF via the @/shared SSOT.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import { ItemLifecycleTracker, itemLifecycleEnabled } from "@/stream/item-lifecycle"

const types = (evs: readonly AgentEvent[]) => evs.map((e) => e.type)
const text = (delta: string): AgentEvent => ({ type: "assistant_text", delta })
const call = (id: string): AgentEvent =>
  ({ type: "tool_call", id, name: "read", input: {} }) as AgentEvent
const result = (id: string): AgentEvent =>
  ({ type: "tool_result", id, name: "read", ok: true, preview: "" }) as AgentEvent
const done: AgentEvent = { type: "done", reason: "ok", turns: 1 }

describe("ItemLifecycleTracker — text run", () => {
  test("first delta opens + updates; later deltas only update", () => {
    const t = new ItemLifecycleTracker()
    expect(types(t.track(text("Hel")))).toEqual(["item_started", "item_updated"])
    expect(types(t.track(text("lo")))).toEqual(["item_updated"])
  })
  test("started carries kind text + index 0; updates carry same itemId", () => {
    const t = new ItemLifecycleTracker()
    const [started, updated] = t.track(text("x"))
    expect(started).toMatchObject({ type: "item_started", itemKind: "text", index: 0 })
    if (started?.type === "item_started" && updated?.type === "item_updated") {
      expect(updated.itemId).toBe(started.itemId)
    }
  })
})

describe("ItemLifecycleTracker — tool items + boundaries", () => {
  test("tool_call closes open text, opens tool item (id = tool id)", () => {
    const t = new ItemLifecycleTracker()
    t.track(text("a"))
    const out = t.track(call("t1"))
    expect(types(out)).toEqual(["item_completed", "item_started"])
    expect(out[1]).toMatchObject({ type: "item_started", itemId: "t1", itemKind: "tool" })
  })
  test("tool_result completes a STARTED tool item by id", () => {
    const t = new ItemLifecycleTracker()
    t.track(call("t1"))
    expect(t.track(result("t1"))).toEqual([{ type: "item_completed", itemId: "t1" }])
  })
  test("R1 F2: orphan tool_result (no prior call) ⇒ [] (no phantom completion)", () => {
    expect(new ItemLifecycleTracker().track(result("ghost"))).toEqual([])
  })
  test("R1 F2: done closes an OPEN tool item (aborted turn, no result)", () => {
    const t = new ItemLifecycleTracker()
    t.track(call("t1"))
    // done must complete the dangling tool item, not leave a forever-spinner.
    expect(t.track(done)).toEqual([{ type: "item_completed", itemId: "t1" }])
  })
  test("R1 F2: a completed tool is not re-closed at the boundary", () => {
    const t = new ItemLifecycleTracker()
    t.track(call("t1"))
    t.track(result("t1"))
    expect(t.track(done)).toEqual([]) // already completed ⇒ nothing dangling
  })
  test("R2: a DUPLICATE tool_call for an open id ⇒ [] (no orphan 2nd start)", () => {
    const t = new ItemLifecycleTracker()
    expect(types(t.track(call("t1")))).toEqual(["item_started"])
    expect(t.track(call("t1"))).toEqual([]) // duplicate ignored
    // exactly one start ⇒ exactly one completion at the boundary
    expect(t.track(done)).toEqual([{ type: "item_completed", itemId: "t1" }])
  })
  test("done closes an open text item", () => {
    const t = new ItemLifecycleTracker()
    t.track(text("a"))
    expect(types(t.track(done))).toEqual(["item_completed"])
  })
  test("done with no open item ⇒ []", () => {
    expect(new ItemLifecycleTracker().track(done)).toEqual([])
  })
  test("monotonic index across items", () => {
    const t = new ItemLifecycleTracker()
    const a = t.track(text("a"))[0]
    const b = t.track(call("t1"))[1]
    if (a?.type === "item_started" && b?.type === "item_started") {
      expect(b.index).toBe(a.index + 1)
    }
  })
})

describe("itemLifecycleEnabled — default-OFF", () => {
  test("gate via @/shared SSOT", () => {
    expect(itemLifecycleEnabled({})).toBe(false)
    expect(itemLifecycleEnabled({ QUANTA_ITEM_LIFECYCLE: "1" })).toBe(true)
    expect(itemLifecycleEnabled({ QUANTA_ITEM_LIFECYCLE: "off" })).toBe(false)
  })
})
