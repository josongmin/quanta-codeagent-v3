/**
 * T01 — item-stream projector (SINGLE SOURCE of fine-grained item cores).
 *
 * Stateful, pure-w.r.t.-I/O projector that consumes the existing in-proc
 * {@link AgentEvent} stream and yields the {@link ItemStreamCore}s to surface
 * ALONGSIDE each event. It is the ONE place `AgentEvent → item` lives; the two
 * wire transports (session.v1 `item.*` events, web agent-state `item.*`
 * messages) each own an INSTANCE fed the SAME event order, so both emit
 * byte-identical cores — proven by the drift ratchet
 * (`tests/unit/item-stream-projection-drift-hellgate.test.ts`).
 *
 * Model:
 *  - REASONING item: one run of `assistant_thinking` deltas. Opens on the first
 *    delta, accumulates, and CLOSES (flush) when any non-thinking event arrives
 *    OR at a turn boundary. A later thinking run opens a fresh item.
 *  - TOOL item: opens at `tool_call` (type classified by name —
 *    commandExecution / fileChange / tool), takes `tool_progress` deltas, and
 *    closes at the matching `tool_result` (by id). A turn boundary closes any
 *    tool item that never got a result (aborted/throwing turn).
 *
 * Ids: reasoning items use a deterministic `item-reasoning-<index>`; tool items
 * reuse the tool-call id (so a surface joins the item to its `tool.invoked`
 * row). `index` is monotonic across ALL items.
 *
 * Accumulation → flush: deltas are accumulated; `completed.text` carries the
 * full body (absent when the item produced no deltas). This is the
 * event-driven L3-partial flush pattern — no timer, no race.
 */
import {
  classifyToolItemType,
  ITEM_DELTA_KIND_BY_ITEM_TYPE,
  type ItemStreamCore,
  type ItemStreamItemType,
} from "@/shared"
import type { AgentEvent } from "./types"

interface OpenTool {
  readonly itemId: string
  readonly itemType: ItemStreamItemType
  text: string
}

export class ItemStreamProjector {
  /** The currently-open REASONING item (at most one). */
  private openReasoning: { readonly itemId: string; text: string } | null = null
  /** Tool items started but not yet completed, keyed by tool-call id. */
  private readonly openTools = new Map<string, OpenTool>()
  private index = 0

  /** Project the item cores to surface alongside `ev`. Mutates only this
   *  projector's own cursor; deterministic in `ev` + prior state. */
  project(ev: AgentEvent): ItemStreamCore[] {
    switch (ev.type) {
      case "assistant_thinking":
        return this.onThinking(ev.delta)
      // The model moved ON from thinking to its visible answer ⇒ flush reasoning.
      case "assistant_text":
        return this.closeReasoning()
      case "tool_call":
        return this.onToolCall(ev.id, ev.name)
      case "tool_progress":
        return this.onToolProgress(ev.id, ev.message)
      case "tool_result":
        return this.onToolResult(ev.id)
      case "turn_start":
      case "done":
        return this.closeAll()
      default:
        // Transient / telemetry events (in_progress, output_progress, usage,
        // ratelimit_snapshot, knobs_applied, …) MUST NOT close an open reasoning
        // run — they interleave with thinking deltas and a premature close would
        // spuriously split one reasoning item into several. Only the answer, a
        // tool call, or a turn boundary ends reasoning.
        return []
    }
  }

  private onThinking(delta: string): ItemStreamCore[] {
    const out: ItemStreamCore[] = []
    if (this.openReasoning === null) {
      const itemId = `item-reasoning-${this.index}`
      out.push({ phase: "started", itemId, itemType: "reasoning", index: this.index++ })
      this.openReasoning = { itemId, text: "" }
    }
    this.openReasoning.text += delta
    out.push({
      phase: "delta",
      itemId: this.openReasoning.itemId,
      itemType: "reasoning",
      deltaKind: ITEM_DELTA_KIND_BY_ITEM_TYPE.reasoning,
      delta,
    })
    return out
  }

  private onToolCall(id: string, name: string): ItemStreamCore[] {
    // A duplicate tool_call for an already-open id must NOT open a 2nd item
    // (orphan that can never be completed) — ignore it, but DO still close any
    // open reasoning (the model emitted a tool call, reasoning is over).
    if (this.openTools.has(id)) return this.closeReasoning()
    const out = this.closeReasoning()
    const itemType = classifyToolItemType(name)
    this.openTools.set(id, { itemId: id, itemType, text: "" })
    out.push({ phase: "started", itemId: id, itemType, index: this.index++ })
    return out
  }

  private onToolProgress(id: string, message: string): ItemStreamCore[] {
    const open = this.openTools.get(id)
    // Orphan progress (no prior tool_call) is ignored — no phantom item.
    if (open === undefined) return []
    open.text += message
    return [
      {
        phase: "delta",
        itemId: open.itemId,
        itemType: open.itemType,
        deltaKind: ITEM_DELTA_KIND_BY_ITEM_TYPE[open.itemType],
        delta: message,
      },
    ]
  }

  private onToolResult(id: string): ItemStreamCore[] {
    const open = this.openTools.get(id)
    // Complete ONLY a tool item we actually started (no phantom completion).
    if (open === undefined) return []
    this.openTools.delete(id)
    return [completedOf(open.itemId, open.itemType, open.text)]
  }

  private closeReasoning(): ItemStreamCore[] {
    if (this.openReasoning === null) return []
    const { itemId, text } = this.openReasoning
    this.openReasoning = null
    return [completedOf(itemId, "reasoning", text)]
  }

  /** Close the open reasoning item AND every still-open tool item (turn boundary). */
  private closeAll(): ItemStreamCore[] {
    const out = this.closeReasoning()
    for (const open of this.openTools.values()) {
      out.push(completedOf(open.itemId, open.itemType, open.text))
    }
    this.openTools.clear()
    return out
  }
}

const completedOf = (
  itemId: string,
  itemType: ItemStreamItemType,
  text: string,
): ItemStreamCore => ({
  phase: "completed",
  itemId,
  itemType,
  ...(text.length > 0 ? { text } : {}),
})
