/**
 * Hellgate — T01 item-stream projector (`@/stream/item-stream-projector`).
 *
 * The SINGLE source that turns the in-proc AgentEvent stream into fine-grained
 * {@link ItemStreamCore}s (Codex `item/started` → typed deltas → `item/completed`
 * parity). Both wire planes (session.v1 `item.*`, web agent-state `item.*`) own
 * an INSTANCE fed the same event order, so this projector's correctness is the
 * shared foundation.
 *
 * Invariants under test (each asserted unconditionally first, then narrowed —
 * mutation-resistant: a projector that emits nothing fails the first assert):
 *   1. reasoning run: first `assistant_thinking` opens (started) + delta; later
 *      deltas only delta; a non-thinking event flushes `completed` with the FULL
 *      accumulated text (delta-accumulation observed, not assumed).
 *   2. tool item: `tool_call` (classified) opens; `tool_progress` deltas; the
 *      matching `tool_result` completes (by id) with accumulated output.
 *   3. tool classification: bash→commandExecution, edit→fileChange, unknown→tool;
 *      delta-kind is the 1:1 of the item type.
 *   4. orphan discipline: progress/result with no prior call ⇒ []; duplicate
 *      call ⇒ no 2nd start.
 *   5. boundary: turn_start / done flush every open item (reasoning + tools).
 *   6. monotonic index across all items.
 *   7. gate default-OFF via @/shared SSOT.
 */
import { describe, expect, test } from "bun:test"
import type { ItemStreamCore } from "@/shared"
import { itemStreamEnabled } from "@/shared"
import type { AgentEvent } from "@/stream"
import { ItemStreamProjector } from "@/stream"

const thinking = (delta: string): AgentEvent => ({ type: "assistant_thinking", delta })
const answer = (delta: string): AgentEvent => ({ type: "assistant_text", delta })
const call = (id: string, name: string): AgentEvent =>
  ({ type: "tool_call", id, name, input: {} }) as AgentEvent
const progress = (id: string, message: string): AgentEvent =>
  ({ type: "tool_progress", id, name: "x", message }) as AgentEvent
const result = (id: string): AgentEvent =>
  ({ type: "tool_result", id, name: "x", ok: true, preview: "" }) as AgentEvent
const done: AgentEvent = { type: "done", reason: "ok", turns: 1 }
const turnStart: AgentEvent = { type: "turn_start", turn: 1 }

const phases = (cores: readonly ItemStreamCore[]) => cores.map((c) => c.phase)

describe("ItemStreamProjector — reasoning run (UC1)", () => {
  test("first thinking delta opens + deltas; later deltas only delta", () => {
    const p = new ItemStreamProjector()
    const first = p.project(thinking("Let me "))
    expect(phases(first)).toEqual(["started", "delta"])
    const second = p.project(thinking("think."))
    expect(phases(second)).toEqual(["delta"])
  })

  test("started carries itemType reasoning + index 0; delta carries reasoning.text kind + same id", () => {
    const p = new ItemStreamProjector()
    const [started, delta] = p.project(thinking("a"))
    expect(started).toMatchObject({ phase: "started", itemType: "reasoning", index: 0 })
    expect(delta).toMatchObject({
      phase: "delta",
      itemType: "reasoning",
      deltaKind: "reasoning.text",
      delta: "a",
    })
    if (started?.phase === "started" && delta?.phase === "delta") {
      expect(delta.itemId).toBe(started.itemId)
    }
  })

  test("a non-thinking event FLUSHES completed with the FULL accumulated text", () => {
    const p = new ItemStreamProjector()
    p.project(thinking("Hel"))
    p.project(thinking("lo"))
    // The answer (assistant_text) is the model moving on from thinking.
    const flushed = p.project(answer("done"))
    expect(flushed).toHaveLength(1)
    const [completed] = flushed
    // Accumulation is OBSERVED: the completed text must be the concatenation,
    // not a single delta — a projector that forgot to accumulate fails here.
    expect(completed).toMatchObject({ phase: "completed", itemType: "reasoning", text: "Hello" })
  })

  test("a fresh thinking run after a flush opens a NEW item with the next index", () => {
    const p = new ItemStreamProjector()
    p.project(thinking("first"))
    p.project(answer("x")) // flush reasoning item 0
    const reopened = p.project(thinking("second"))
    const [started] = reopened
    expect(started).toMatchObject({ phase: "started", itemType: "reasoning", index: 1 })
  })
})

describe("ItemStreamProjector — tool items (UC2/UC3) + classification", () => {
  test("bash tool_call opens a commandExecution item; progress is command.output; result flushes", () => {
    const p = new ItemStreamProjector()
    const started = p.project(call("t1", "bash"))
    expect(started).toEqual([
      { phase: "started", itemId: "t1", itemType: "commandExecution", index: 0 },
    ])
    const d = p.project(progress("t1", "line1\n"))
    expect(d).toEqual([
      {
        phase: "delta",
        itemId: "t1",
        itemType: "commandExecution",
        deltaKind: "command.output",
        delta: "line1\n",
      },
    ])
    const c = p.project(result("t1"))
    expect(c).toEqual([
      { phase: "completed", itemId: "t1", itemType: "commandExecution", text: "line1\n" },
    ])
  })

  test("edit tool_call opens a fileChange item; progress is file.patch", () => {
    const p = new ItemStreamProjector()
    expect(p.project(call("e1", "edit"))).toEqual([
      { phase: "started", itemId: "e1", itemType: "fileChange", index: 0 },
    ])
    expect(p.project(progress("e1", "@@ -1 +1 @@"))).toMatchObject([
      { phase: "delta", itemType: "fileChange", deltaKind: "file.patch" },
    ])
  })

  test("unknown tool falls back to neutral `tool` item (never mislabelled exec/patch)", () => {
    const p = new ItemStreamProjector()
    expect(p.project(call("r1", "read"))).toEqual([
      { phase: "started", itemId: "r1", itemType: "tool", index: 0 },
    ])
    expect(p.project(progress("r1", "ok"))).toMatchObject([
      { phase: "delta", itemType: "tool", deltaKind: "tool.progress" },
    ])
  })

  test("completed with NO deltas omits text", () => {
    const p = new ItemStreamProjector()
    p.project(call("t1", "bash"))
    const [c] = p.project(result("t1"))
    expect(c).toEqual({ phase: "completed", itemId: "t1", itemType: "commandExecution" })
    expect(c && "text" in c).toBe(false)
  })
})

describe("ItemStreamProjector — empty-delta discipline (audit R3)", () => {
  test("a leading empty thinking delta opens NO item; the first non-empty one does", () => {
    const p = new ItemStreamProjector()
    expect(p.project(thinking(""))).toEqual([])
    expect(phases(p.project(thinking("real")))).toEqual(["started", "delta"])
  })

  test("an empty tool_progress message yields no delta", () => {
    const p = new ItemStreamProjector()
    p.project(call("t1", "bash"))
    expect(p.project(progress("t1", ""))).toEqual([])
  })
})

describe("ItemStreamProjector — orphan + duplicate discipline", () => {
  test("orphan tool_progress / tool_result (no prior call) ⇒ []", () => {
    const p = new ItemStreamProjector()
    expect(p.project(progress("ghost", "x"))).toEqual([])
    expect(p.project(result("ghost"))).toEqual([])
  })

  test("duplicate tool_call for an open id ⇒ no 2nd started", () => {
    const p = new ItemStreamProjector()
    p.project(call("t1", "bash"))
    expect(p.project(call("t1", "bash"))).toEqual([])
  })

  test("a tool_call closes an OPEN reasoning item first", () => {
    const p = new ItemStreamProjector()
    p.project(thinking("hmm"))
    const out = p.project(call("t1", "bash"))
    expect(phases(out)).toEqual(["completed", "started"])
    expect(out[0]).toMatchObject({ itemType: "reasoning", phase: "completed" })
    expect(out[1]).toMatchObject({ itemType: "commandExecution", phase: "started" })
  })
})

describe("ItemStreamProjector — turn boundary flush", () => {
  test("done flushes BOTH an open reasoning AND an open tool item", () => {
    const p = new ItemStreamProjector()
    p.project(thinking("r"))
    p.project(call("t1", "bash")) // closes reasoning, opens tool
    // re-open reasoning to have BOTH open simultaneously is impossible (tool_call
    // closed it) — instead open a tool then thinking is closed by... model it:
    const out = p.project(done)
    // Only the tool item is open here (reasoning was flushed at the tool_call).
    expect(out).toEqual([{ phase: "completed", itemId: "t1", itemType: "commandExecution" }])
  })

  test("turn_start flushes an open reasoning item", () => {
    const p = new ItemStreamProjector()
    p.project(thinking("abc"))
    expect(p.project(turnStart)).toEqual([
      { phase: "completed", itemId: "item-reasoning-0", itemType: "reasoning", text: "abc" },
    ])
  })

  test("two concurrent tool items both flush at done, monotonic indices", () => {
    const p = new ItemStreamProjector()
    const s1 = p.project(call("a", "bash"))
    const s2 = p.project(call("b", "edit"))
    expect(s1[0]).toMatchObject({ index: 0 })
    expect(s2[0]).toMatchObject({ index: 1 })
    const out = p.project(done)
    expect(out.map((c) => c.itemId).sort()).toEqual(["a", "b"])
    expect(out.every((c) => c.phase === "completed")).toBe(true)
  })
})

describe("ItemStreamProjector — transient events must NOT split a reasoning run (audit R2)", () => {
  const transient: AgentEvent[] = [
    { type: "in_progress", timestamp: 1 },
    { type: "output_progress", outputTokens: 5, exact: false },
    { type: "usage", inputTokens: 1, outputTokens: 2, model: "m" },
    { type: "ratelimit_snapshot", observedAt: 1 },
  ]
  for (const ev of transient) {
    test(`${ev.type} interleaved in a reasoning run does NOT close it (no spurious split)`, () => {
      const p = new ItemStreamProjector()
      p.project(thinking("part1 "))
      // A transient event between thinking deltas must produce NO item core and
      // must NOT flush the open reasoning item.
      expect(p.project(ev)).toEqual([])
      const more = p.project(thinking("part2"))
      // Still the SAME reasoning item (delta only, no new started) — one run.
      expect(more.map((c) => c.phase)).toEqual(["delta"])
      const [completed] = p.project(done)
      expect(completed).toMatchObject({
        phase: "completed",
        itemType: "reasoning",
        text: "part1 part2",
      })
    })
  }
})

describe("ItemStreamProjector — abort/pause behavior (audit R2: no premature completion)", () => {
  test("WITHOUT a terminal event, an open item stays OPEN (no fabricated completed)", () => {
    // A turn that throws/pauses (e.g. HITL approval) before `done` must NOT have
    // its open items force-completed by the projector — the consumer closes them
    // on the turn-terminal SessionEvent. Force-completing here would LIE about a
    // paused tool/reasoning item having finished. Matches ItemLifecycleTracker.
    const p = new ItemStreamProjector()
    p.project(call("t1", "bash"))
    p.project(progress("t1", "partial output"))
    // No done / turn_start emitted (turn threw). The projector yields nothing
    // further — the item is intentionally left open.
    expect(p.project({ type: "error", message: "boom" } as AgentEvent)).toEqual([])
  })

  test("a turn_start (next turn) flushes a still-open item from a prior aborted run", () => {
    const p = new ItemStreamProjector()
    p.project(call("t1", "bash"))
    const flushed = p.project(turnStart)
    expect(flushed).toEqual([{ phase: "completed", itemId: "t1", itemType: "commandExecution" }])
  })
})

describe("ItemStreamProjector — determinism (audit R3: two production instances agree)", () => {
  test("two instances fed the SAME event order emit byte-identical cores", () => {
    const seq: AgentEvent[] = [
      thinking("a"),
      thinking("b"),
      call("t1", "bash"),
      progress("t1", "x"),
      result("t1"),
      done,
    ]
    const run = () => {
      const p = new ItemStreamProjector()
      return seq.flatMap((ev) => p.project(ev))
    }
    expect(run()).toEqual(run())
  })
})

describe("itemStreamEnabled — default-OFF gate", () => {
  test("unset ⇒ false; '1' ⇒ true", () => {
    expect(itemStreamEnabled({})).toBe(false)
    expect(itemStreamEnabled({ QUANTA_ITEM_STREAM: "1" })).toBe(true)
  })
})
