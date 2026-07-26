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
 *
 * Abort / pause posture (audit R2): open items are flushed ONLY by `done` /
 * `turn_start`. A turn that THROWS before `done` (an uncaught error, or a HITL
 * approval-required PAUSE) intentionally leaves its items OPEN — the projector
 * never fabricates a `completed`, because a paused tool/reasoning item has NOT
 * finished and force-completing it would lie. The consumer closes open items on
 * the turn-terminal SessionEvent (`turn.completed` / `turn.failed`). This
 * matches the established {@link ItemLifecycleTracker} baseline and is uniform
 * across BOTH wire planes (no asymmetric flush plumbing).
 */
import {
  classifyToolItemType,
  ITEM_DELTA_KIND_BY_ITEM_TYPE,
  type ItemStreamCore,
  type ItemStreamItemType,
  sanitizeLogText,
} from "@/shared"
import type { AgentEvent, PlanDeltaReadonlyMirror, PlanReadonlyMirror } from "./types"

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
  /** S2 — the currently-open PLAN item (at most one). A plan snapshot opens it
   *  and immediately completes a full-state copy; a `plan_updated` re-opens (or
   *  re-uses) it to carry an incremental `plan.patch` delta. The plan item's
   *  lifespan is the plan's, not a turn's, so it is NOT closed at a turn
   *  boundary (`closeAll`) — a plan persists across turns. */
  private openPlanItemId: string | null = null
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
      // S2 unified-observability (jul-03): FOLD the plan + subagent models onto
      // co-equal plan/subagent item cores — the ONE stream, so a surface renders
      // every agent-interior concern (reasoning / tool / plan / subagent) from a
      // single item taxonomy. Previously dropped by the `default` arm (plan state
      // rode the separate `plan.*` host-mirror channel; subagents rode the
      // activity spine). A plan `started+completed` pair per snapshot carries the
      // DAG in `completed.text` (JSON) — blockedBy=dependencies, owner=assignee,
      // a `blocked` status carried INSIDE the payload (NOT a 5th itemType).
      case "plan_created":
      case "plan_snapshot":
        return this.onPlanSnapshot(ev.plan)
      case "plan_updated":
        return this.onPlanUpdate(ev.delta, ev.version)
      case "subagent_cancel":
        return this.onSubagentCancel(ev.subagentId, ev.outcome)
      // jul-15 W2 — a surfaced peer/side-agent message folds onto ONE atomic
      // `peerMessage` item (started+completed), the SAME shape as subagent_cancel.
      case "peer_message":
        return this.onPeerMessage(ev)
      case "subagent_delivery":
        return this.onSubagentDelivery(ev)
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
    // Empty deltas carry no signal (the 1:1 bridge likewise drops empty
    // assistant_text). Skipping them avoids opening a spurious empty reasoning
    // item on a leading empty delta and avoids zero-width delta noise.
    if (delta.length === 0) return []
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
    if (message.length === 0) return []
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

  /**
   * S2 — project a plan snapshot (`plan_created` / `plan_snapshot`) onto a
   * `plan` item. Deterministic id from the plan's id so a later `plan_updated`
   * delta attaches to the SAME item. The full DAG snapshot rides `completed.text`
   * as JSON (blockedBy=dependencies, owner=assignee, `blocked` status carried
   * INSIDE the payload). A re-snapshot of an already-open plan re-completes the
   * same item id (idempotent re-paint) rather than opening a duplicate.
   */
  private onPlanSnapshot(plan: PlanReadonlyMirror): ItemStreamCore[] {
    const itemId = `item-plan-${plan.id}`
    const out: ItemStreamCore[] = []
    if (this.openPlanItemId !== itemId) {
      out.push({ phase: "started", itemId, itemType: "plan", index: this.index++ })
      this.openPlanItemId = itemId
    }
    out.push({ phase: "completed", itemId, itemType: "plan", text: JSON.stringify(plan) })
    return out
  }

  /**
   * S2 — project a `plan_updated` onto a `plan.patch` delta on the open plan
   * item. If no plan item is open yet (an update arrived before any snapshot —
   * e.g. a late-attaching surface), a fresh plan item is opened first so the
   * delta is never orphaned. The delta body carries the incremental change +
   * new version as JSON.
   */
  private onPlanUpdate(delta: PlanDeltaReadonlyMirror, version: number): ItemStreamCore[] {
    const out: ItemStreamCore[] = []
    let itemId = this.openPlanItemId
    if (itemId === null) {
      itemId = `item-plan-v${version}`
      out.push({ phase: "started", itemId, itemType: "plan", index: this.index++ })
      this.openPlanItemId = itemId
    }
    out.push({
      phase: "delta",
      itemId,
      itemType: "plan",
      deltaKind: ITEM_DELTA_KIND_BY_ITEM_TYPE.plan,
      delta: JSON.stringify({ delta, version }),
    })
    return out
  }

  /**
   * S2 — project a `subagent_cancel` onto a `subagent` item (started+completed).
   * The item id reuses the subagent id so a surface joins it to the fleet row /
   * L0 root. The `outcome` rides `completed.text` (drilldown detail). A cancel
   * is terminal, so the item opens and closes in one shot (no open-item state).
   */
  private onSubagentCancel(subagentId: string, outcome: string): ItemStreamCore[] {
    const itemId = `item-subagent-${subagentId}`
    return [
      { phase: "started", itemId, itemType: "subagent", index: this.index++ },
      { phase: "completed", itemId, itemType: "subagent", text: outcome },
    ]
  }

  /**
   * jul-15 W2 — project a surfaced `peer_message` onto ONE atomic `peerMessage`
   * item (started+completed, mirrors {@link onSubagentCancel}). A surfaced message
   * is terminal, so it opens and closes in one shot (no open-item state). The
   * attribution + body ride `completed.text` as `<from>→<to> [kind] <body>`; a
   * unique item id keeps concurrent messages distinct within a turn.
   */
  private onPeerMessage(ev: Extract<AgentEvent, { type: "peer_message" }>): ItemStreamCore[] {
    // Belt-and-suspenders anti-forge on the web/session item wire: `from`/`to`/
    // `kind` are runner-minted today (never model input) but sanitized anyway; and
    // `body` is sanitized here too — the emit-boundary redactor DEFAULTS TO IDENTITY
    // (surface-notify), so a host that doesn't wire a sanitizing redactor would
    // otherwise let control chars reach the web `text`. (Astral chars survive — the
    // sanitizer strips only control/escape/bidi/lone-surrogate sequences.)
    const itemId = `item-peer-${sanitizeLogText(ev.from)}-${ev.sentAt}-${this.index}`
    const text = `${sanitizeLogText(ev.from)}→${sanitizeLogText(ev.to)} [${sanitizeLogText(ev.kind)}] ${sanitizeLogText(ev.body)}`
    return [
      { phase: "started", itemId, itemType: "peerMessage", index: this.index++ },
      { phase: "completed", itemId, itemType: "peerMessage", text },
    ]
  }

  private onSubagentDelivery(
    ev: Extract<AgentEvent, { type: "subagent_delivery" }>,
  ): ItemStreamCore[] {
    const itemId = `item-delivery-${ev.deliveryId}-${ev.phase}`
    const text =
      ev.phase === "admitted"
        ? `steer ${ev.deliveryId} accepted for ${ev.targetTaskId} turn ${ev.targetTurnId}`
        : `steer ${ev.deliveryId} finalized ${ev.status}${"reason" in ev ? ` (${ev.reason})` : ""}`
    return [
      { phase: "started", itemId, itemType: "peerMessage", index: this.index++ },
      { phase: "completed", itemId, itemType: "peerMessage", text },
    ]
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
