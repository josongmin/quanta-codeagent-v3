/**
 * W2-2 + W2-3 (jul-15) HELLGATE — peer_message item-stream projection + CLI render.
 *
 * W2-2: the item-stream projector folds a `peer_message` AgentEvent onto ONE
 *       atomic `peerMessage` item (started+completed), with the attribution +
 *       body on `completed.text`. The item→delta drift guard stays exhaustive.
 * W2-3: the stdout adapter renders a `peer_message` as a DIM attribution label
 *       above the (collapsed) body — Codex "Sent from another task", terminal
 *       dialect. Side-agent provenance ⇒ a "side agent finding" label; a body
 *       over the line cap gets a "+N more" marker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ITEM_DELTA_KIND_BY_ITEM_TYPE, type ItemStreamItemType } from "@/shared"
import type { AgentEvent } from "@/stream"
import { ItemStreamProjector, StdoutStream } from "@/stream"

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const peerEvent = (
  over: Partial<Extract<AgentEvent, { type: "peer_message" }>> = {},
): AgentEvent => ({
  type: "peer_message",
  from: "root/1",
  to: "root",
  kind: "request",
  body: "compute the sum",
  sentAt: 100,
  provenance: { source: "peer" },
  ...over,
})

// ── W2-2: projector ─────────────────────────────────────────────────────────────

describe("W2-2 — item-stream projector folds peer_message onto an atomic peerMessage item", () => {
  test("started + completed pair, attribution + body on completed.text", () => {
    const cores = new ItemStreamProjector().project(peerEvent())
    expect(cores).toHaveLength(2)
    expect(cores[0]).toMatchObject({ phase: "started", itemType: "peerMessage" })
    expect(cores[1]).toMatchObject({ phase: "completed", itemType: "peerMessage" })
    // Same item id opens and closes the pair.
    expect(cores[0]?.itemId).toBe(cores[1]?.itemId)
    const completed = cores[1]
    if (completed?.phase !== "completed") throw new Error("expected completed core")
    expect(completed.text).toBe("root/1→root [request] compute the sum")
  })

  test("concurrent peer messages get DISTINCT item ids within a turn", () => {
    const p = new ItemStreamProjector()
    const a = p.project(peerEvent({ from: "root/1", sentAt: 100 }))
    const b = p.project(peerEvent({ from: "root/1", sentAt: 100 }))
    expect(a[0]?.itemId).not.toBe(b[0]?.itemId)
  })

  test("a non-peer event does NOT produce a peerMessage item (no false positive)", () => {
    const cores = new ItemStreamProjector().project({ type: "turn_start", turn: 1 })
    expect(cores.every((c) => c.itemType !== "peerMessage")).toBe(true)
  })
})

describe("subagent_delivery lifecycle projection", () => {
  test("admission projects as pending and finalization as a correlated terminal item", () => {
    const p = new ItemStreamProjector()
    const admitted = p.project({
      type: "subagent_delivery",
      phase: "admitted",
      deliveryId: "del-7",
      requestedMode: "steer",
      status: "accepted",
      targetTaskId: "task-7",
      targetTurnId: "turn-7",
    })
    const finalized = p.project({
      type: "subagent_delivery",
      phase: "finalized",
      deliveryId: "del-7",
      requestedMode: "steer",
      status: "degraded",
      effectiveMode: "queue",
      reason: "action_queue_full",
      messageId: "msg-7",
    })

    expect(admitted[1]).toMatchObject({
      phase: "completed",
      text: "steer del-7 accepted for task-7 turn turn-7",
    })
    expect(finalized[1]).toMatchObject({
      phase: "completed",
      text: "steer del-7 finalized degraded (action_queue_full)",
    })
  })
})

// ── W2-2: item→delta drift guard stays exhaustive ───────────────────────────────

describe("W2-2 — ITEM_DELTA_KIND_BY_ITEM_TYPE covers peerMessage (runtime drift guard)", () => {
  test("every item type (incl. peerMessage) has a delta-kind entry", () => {
    const ALL: ItemStreamItemType[] = [
      "reasoning",
      "commandExecution",
      "fileChange",
      "tool",
      "plan",
      "subagent",
      "progressCard",
      "peerMessage",
    ]
    for (const t of ALL) {
      expect(ITEM_DELTA_KIND_BY_ITEM_TYPE[t]).toBeDefined()
    }
    // Reverse: the map has no extra/missing keys vs the enumerated set. This
    // reverse-totality check is the load-bearing guard (it catches a FUTURE item
    // type added without a delta-kind). The `.peerMessage` entry exists only to
    // satisfy the total map — a surfaced message is atomic (started+completed), so
    // no incremental `delta` is ever emitted for it.
    expect(Object.keys(ITEM_DELTA_KIND_BY_ITEM_TYPE).sort()).toEqual([...ALL].sort())
    expect(ITEM_DELTA_KIND_BY_ITEM_TYPE.peerMessage).toBe("peerMessage.text")
  })
})

// ── W2-3: stdout render ─────────────────────────────────────────────────────────

describe("W2-3 — stdout renders peer_message as a labeled, collapsed bubble", () => {
  const realWrite = process.stdout.write.bind(process.stdout)
  let captured: string[]

  beforeEach(() => {
    captured = []
    process.stdout.write = ((chunk: unknown): boolean => {
      captured.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })
  afterEach(() => {
    process.stdout.write = realWrite
  })
  const out = () => captured.join("")

  test("ordinary peer message ⇒ DIM 'sent by <from> — from another task [kind]' + body", () => {
    new StdoutStream().emit(peerEvent({ from: "root/2", kind: "request", body: "please review" }))
    const text = out()
    expect(text).toContain("✉ sent by root/2 — from another task [request]")
    expect(text).toContain("please review")
    expect(text).toContain(DIM)
    expect(text).toContain(RESET)
  })

  test("subagent delivery renders the correlated lifecycle without claiming admission success", () => {
    const stream = new StdoutStream()
    stream.emit({
      type: "subagent_delivery",
      phase: "admitted",
      deliveryId: "del-render",
      requestedMode: "steer",
      status: "accepted",
      targetTaskId: "task-render",
      targetTurnId: "turn-render",
    })
    const text = out()
    expect(text).toContain("steer delivery del-render accepted")
    expect(text).not.toContain("applied")
  })

  test("side-agent provenance ⇒ 'side agent finding' label with the daemon id", () => {
    new StdoutStream().emit(
      peerEvent({ provenance: { source: "side-agent", daemonId: "sa-7" }, body: "BUILD BROKEN" }),
    )
    const text = out()
    expect(text).toContain("✉ sent by sa-7 — side agent finding")
    expect(text).toContain("BUILD BROKEN")
    // The peer-only "[kind]" tag is NOT shown for a side-agent finding.
    expect(text).not.toContain("from another task")
  })

  test("a body over the line cap is collapsed with a '+N more' marker", () => {
    const body = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\n")
    new StdoutStream().emit(peerEvent({ body }))
    const text = out()
    expect(text).toContain("l4")
    expect(text).not.toContain("l5") // beyond the 4-line cap
    expect(text).toContain("+2 more lines")
    expect(text).toContain("subagent_read_messages")
  })
})
