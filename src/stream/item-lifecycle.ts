/**
 * Item lifecycle projector (gap-other-agent GAP 10).
 *
 * Codex emits per-output-item lifecycle events (ItemStarted/Updated/Completed)
 * so an SDK/UI can show granular progress (this text run / this tool call) WITHOUT
 * waiting for the whole turn. quanta's stream is turn-granular. This pure,
 * stateful projector is fed the existing {@link AgentEvent} stream and returns the
 * item lifecycle events to emit ALONGSIDE each one — additive and opt-in.
 *
 * Model: an assistant text RUN is ONE `text` item (started on the first delta,
 * `item_updated` per delta, completed when a non-text event or a turn boundary
 * arrives). Each tool is a `tool` item — started at its `tool_call`, completed at
 * the matching `tool_result` (by id). Ids are deterministic; `index` is monotonic.
 *
 * Default-OFF: {@link itemLifecycleEnabled} (`QUANTA_ITEM_LIFECYCLE`) governs
 * whether the loop instantiates + runs the tracker. Unwired ⇒ no events emitted,
 * byte-identical. The two exhaustive `AgentEvent` consumers were updated for the
 * new variants: the jsonl recorder SKIPS them (transient UI, like output_progress)
 * and the stdout renderer no-ops them — so a future wiring cannot break the build
 * or throw at runtime. Pure: no I/O.
 */
import { gateOn } from "@/shared"
import type { AgentEvent } from "./types"

export const ITEM_LIFECYCLE_FLAG = "QUANTA_ITEM_LIFECYCLE"

/** Default-OFF opt-in check via the @/shared gate SSOT. */
export const itemLifecycleEnabled = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, ITEM_LIFECYCLE_FLAG)

export class ItemLifecycleTracker {
  /** The currently-open TEXT item. */
  private openText: { readonly id: string } | null = null
  /** Tool items started but not yet completed (by tool id). Tracked so a turn
   *  boundary can close any that never got a `tool_result` (aborted/throwing
   *  turn) — and so an ORPHAN `tool_result` (no prior `tool_call`) is ignored
   *  rather than emitting a phantom `item_completed`. (R1 audit F2.) */
  private readonly openTools = new Set<string>()
  private index = 0

  /** Project lifecycle events to emit alongside `ev`. Pure w.r.t. `ev`; mutates
   *  only this tracker's own cursor. */
  track(ev: AgentEvent): AgentEvent[] {
    switch (ev.type) {
      case "assistant_text":
        return this.onText(ev.delta)
      case "tool_call": {
        // R2 audit: a DUPLICATE tool_call for an already-open id must NOT emit a
        // 2nd item_started — the Set is idempotent so the 2nd start could never be
        // completed (orphan). Ignore the duplicate.
        if (this.openTools.has(ev.id)) return []
        const out = this.closeText()
        this.openTools.add(ev.id)
        out.push(this.start("tool", ev.id))
        return out
      }
      case "tool_result":
        // Complete ONLY a tool item we actually started (no phantom completion).
        return this.openTools.delete(ev.id) ? [{ type: "item_completed", itemId: ev.id }] : []
      case "turn_start":
      case "done":
        return this.closeAll()
      // Transient events produce NO lifecycle item. LISTED EXPLICITLY (not a bare
      // `default`) so a NEW content-bearing AgentEvent arm can't silently drop from
      // the item-lifecycle plane: an unhandled arm makes `ev` non-`never` at the
      // pin below → COMPILE ERROR, forcing a deliberate classification.
      case "session_start":
      case "llm_request":
      case "llm_continuation":
      case "assistant_thinking":
      case "in_progress":
      case "tool_progress":
      case "skill_scope_decision":
      case "permission_escalation_requested":
      case "permission_escalation_resolved":
      case "recovery":
      case "context_compacted":
      case "error":
      case "usage":
      case "output_progress":
      case "response_queued":
      case "interrupted":
      case "subagent_cancel":
      case "subagent_spawn":
      case "subagent_status":
      case "peer_message":
      case "subagent_delivery":
      case "plan_created":
      case "plan_updated":
      case "plan_snapshot":
      case "item_started":
      case "item_updated":
      case "item_completed":
      case "plan_user_input_requested":
      case "plan_user_input_resolved":
      case "mode_changed":
      case "turn_diff_updated":
      case "decision":
      case "knobs_applied":
      case "progress_update":
      case "ratelimit_snapshot":
      case "budget_breach":
      // RFC-01 A7 — render-only advisory (same class as budget_breach); the
      // item-lifecycle projector passes it through untouched.
      case "context_headroom_crossed":
        return []
      default: {
        // Exhaustiveness pin (runtime-safe: no throw).
        const _exhaustive: never = ev
        void _exhaustive
        return []
      }
    }
  }

  private onText(delta: string): AgentEvent[] {
    const out: AgentEvent[] = []
    if (this.openText === null) {
      const id = `item-text-${this.index}`
      out.push(this.start("text", id))
      this.openText = { id }
    }
    out.push({ type: "item_updated", itemId: this.openText.id, delta })
    return out
  }

  private start(kind: "text" | "tool" | "thinking", id: string): AgentEvent {
    return { type: "item_started", itemId: id, itemKind: kind, index: this.index++ }
  }

  private closeText(): AgentEvent[] {
    if (this.openText === null) return []
    const completed: AgentEvent = { type: "item_completed", itemId: this.openText.id }
    this.openText = null
    return [completed]
  }

  /** Close the open text item AND every still-open tool item (turn boundary). */
  private closeAll(): AgentEvent[] {
    const out = this.closeText()
    for (const id of this.openTools) out.push({ type: "item_completed", itemId: id })
    this.openTools.clear()
    return out
  }
}
