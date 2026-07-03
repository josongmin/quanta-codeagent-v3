/**
 * S2 (T01) — React hook over the `item.*` fine-grained item stream.
 *
 * `QUANTA_ITEM_STREAM` projects a turn's interior as discrete ITEMS
 * (`item.started` → 0..N `item.delta` → `item.completed`) on the agent-state
 * channel (mirrors upstream `Item*Message`). The in-band session transcript
 * DROPS these (they're in `TRANSCRIPT_NOOP_SESSION_EVENT_TYPES`); this hook
 * consumes them off the SAME `AgentStateSource` the plan/mode/progress hooks use
 * and folds them into one live {@link ItemStreamState} the `ItemStreamSection`
 * renders as subagent-activity rows.
 *
 * Mirrors `canvas-hooks.ts#toolDiffsReducer` (latest-wins Map + FIFO cap) and
 * `agent-state-hooks.ts` (per-kind narrowing predicates, reducer exported for a
 * node-env unit test). With no source / no frames the hook returns
 * {@link EMPTY_ITEM_STREAM} so the section renders nothing — chat UI unchanged
 * (default-OFF: `QUANTA_ITEM_STREAM` OFF ⇒ no frame ever decodes).
 *
 * Fold semantics (latest-wins per `itemId`, insertion-ordered):
 *   - `item.started`   → upsert item { status: "running", text: "" }
 *   - `item.delta`     → append `delta` to the item's `text` (status stays
 *                        "running"); a delta for an unseen item creates it
 *                        (forward-tolerant to a dropped `started`).
 *   - `item.completed` → mark item "completed"; adopt `text` if the frame
 *                        carries the final text, else keep the accumulated text.
 */

import { useEffect, useReducer } from "react"
import type {
  AgentStateMessage,
  ItemCompletedMessage,
  ItemDeltaMessage,
  ItemStartedMessage,
} from "../types/protocol"
import type { AgentStateSource } from "./agent-state-hooks"

/** One projected item's live state (a subagent-activity row). */
export interface ItemStreamEntry {
  readonly itemId: string
  readonly itemType: string
  readonly itemIndex: number
  readonly status: "running" | "completed"
  /** Accumulated `item.delta` text (or the final `item.completed` text). */
  readonly text: string
}

/** The folded item-stream view — an insertion-ordered latest-wins Map. */
export interface ItemStreamState {
  readonly items: ReadonlyMap<string, ItemStreamEntry>
}

const EMPTY_ITEMS: ReadonlyMap<string, ItemStreamEntry> = new Map()

/** The empty view — what {@link useItemStream} returns before any frame. */
export const EMPTY_ITEM_STREAM: ItemStreamState = { items: EMPTY_ITEMS }

/* ------------------------------------------------------------------ */
/* Per-kind narrowing — the SINGLE filter the reducer routes on.       */
/* Exported + load-bearing (the reducer switches on these) so routing   */
/* is unit-tested directly. Mirrors `agent-state-hooks.ts`.             */
/* ------------------------------------------------------------------ */

export const isItemStartedMsg = (m: AgentStateMessage): m is ItemStartedMessage =>
  m.kind === "item.started"

export const isItemDeltaMsg = (m: AgentStateMessage): m is ItemDeltaMessage =>
  m.kind === "item.delta"

export const isItemCompletedMsg = (m: AgentStateMessage): m is ItemCompletedMessage =>
  m.kind === "item.completed"

/**
 * FIFO backstop, parity with `TOOL_DIFFS_CAP` / `TOOL_PROGRESS_CAP` — a cap so
 * high it never evicts in a normal session, only bounds a pathological one where
 * thousands of distinct items each leave a row. 256 is far beyond any realistic
 * live item count; eviction is oldest-first so the recent window the section
 * renders is always retained. Measure-first: revisit only if real sessions
 * approach it.
 */
export const ITEM_STREAM_CAP = 256

/**
 * Latest-wins insert into an insertion-ordered Map with a FIFO memory cap. `set`
 * on an existing key updates in place WITHOUT reordering (re-touching a recent
 * key never evicts it); a new key over `cap` evicts the oldest inserted key.
 * Mutates `next` (a caller-owned fresh copy). Mirrors the sibling hooks.
 */
const setWithFifoCap = <V>(next: Map<string, V>, key: string, value: V, cap: number): void => {
  next.set(key, value)
  if (next.size > cap) {
    const oldest = next.keys().next().value
    if (oldest !== undefined) next.delete(oldest)
  }
}

type ItemStreamAction = { type: "message"; msg: AgentStateMessage } | { type: "reset" }

/**
 * Fold one agent-state message onto the item-stream view. Pure (exported so the
 * state semantics are unit-tested in the node test env, no DOM). A non-`item.*`
 * kind returns the prior state BY REFERENCE (idle) — the hook shares the
 * agent-state channel with the plan/mode/progress hooks, so most frames are
 * not for us.
 */
export const itemStreamReducer = (
  state: ItemStreamState,
  action: ItemStreamAction,
): ItemStreamState => {
  if (action.type === "reset") return EMPTY_ITEM_STREAM
  const { msg } = action

  if (isItemStartedMsg(msg)) {
    const items = new Map(state.items)
    setWithFifoCap(
      items,
      msg.itemId,
      {
        itemId: msg.itemId,
        itemType: msg.itemType,
        itemIndex: msg.itemIndex,
        status: "running",
        text: "",
      },
      ITEM_STREAM_CAP,
    )
    return { items }
  }

  if (isItemDeltaMsg(msg)) {
    const items = new Map(state.items)
    const prev = items.get(msg.itemId)
    // Forward-tolerant: a delta for an unseen item creates it (a dropped
    // `started`). `itemIndex` is unknown here ⇒ default 0 until a `started`
    // (which upserts in place) supplies it.
    const base: ItemStreamEntry = prev ?? {
      itemId: msg.itemId,
      itemType: msg.itemType,
      itemIndex: 0,
      status: "running",
      text: "",
    }
    setWithFifoCap(
      items,
      msg.itemId,
      { ...base, status: "running", text: base.text + msg.delta },
      ITEM_STREAM_CAP,
    )
    return { items }
  }

  if (isItemCompletedMsg(msg)) {
    const items = new Map(state.items)
    const prev = items.get(msg.itemId)
    const base: ItemStreamEntry = prev ?? {
      itemId: msg.itemId,
      itemType: msg.itemType,
      itemIndex: 0,
      status: "running",
      text: "",
    }
    setWithFifoCap(
      items,
      msg.itemId,
      { ...base, status: "completed", text: msg.text ?? base.text },
      ITEM_STREAM_CAP,
    )
    return { items }
  }

  // Forward-compat: any non-item kind is a no-op (idle).
  return state
}

/**
 * Subscribe to the agent-state channel and fold every `item.*` frame into one
 * live {@link ItemStreamState}. With `source === null` (the gate is OFF / no
 * client) the hook never subscribes and returns {@link EMPTY_ITEM_STREAM} — the
 * section renders nothing (default-OFF, chat UI unchanged).
 */
export const useItemStream = (source: AgentStateSource | null): ItemStreamState => {
  const [state, dispatch] = useReducer(itemStreamReducer, EMPTY_ITEM_STREAM)
  useEffect(() => {
    if (source === null) return
    return source.subscribe((msg) => dispatch({ type: "message", msg }))
  }, [source])
  return state
}
