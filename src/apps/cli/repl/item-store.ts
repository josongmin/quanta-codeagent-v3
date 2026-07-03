/**
 * S2 unified-observability (jul-03) — bounded in-memory item-stream store for
 * the CLI `/activity` surface.
 *
 * Background: the `/activity` fleet snapshot is ALSO pumped onto an
 * {@link ItemStreamSink} (`pumpFleetRowsToItemStream`) so the subagent lifecycle
 * folds into the ONE item taxonomy the wire planes carry. Until now the CLI's
 * sink was `logger.debug`-only (surface-compose ~549) — the item cores were
 * emitted to the structured-log plane but NEVER rendered back to the user, so
 * `QUANTA_ITEM_STREAM` produced ZERO visible rows in the REPL.
 *
 * This store closes that gap: it is BOTH an `ItemStreamSink` (the pump captures
 * into it) AND a bounded snapshot source (`/activity` renders the retained rows
 * as a "Subagent items" section). Pure in-memory, oldest-evicted ring — no I/O,
 * no clock. Each REPL session owns ONE; two concurrent sessions never share.
 *
 * Item cores are keyed by `itemId` (the fleet producer uses `item-subagent-<id>`
 * — see `@/activity` `fleetRowToItemStream`). A `completed` core for an id
 * REPLACES the earlier `started` core for the same id so the store holds the
 * LATEST lifecycle state per item (not a growing log of phase transitions). The
 * insertion order of first-seen ids is preserved for a stable render.
 */

import type { ItemStreamCore, ItemStreamSink } from "@/shared"

/** A retained item — the latest core seen for its `itemId`, plus the phase so
 *  the renderer can show a live spinner (started) vs a settled row (completed). */
export interface RetainedItem {
  readonly itemId: string
  readonly itemType: ItemStreamCore["itemType"]
  readonly phase: ItemStreamCore["phase"]
  /** Accumulated body for a `completed` item (the L0→L2 drilldown JSON the
   *  fleet producer stamps). Absent for a still-open `started` item. */
  readonly text?: string
}

export interface ItemStore extends ItemStreamSink {
  /** Ordered snapshot of the retained items (first-seen id order). Newest
   *  lifecycle state per id. */
  snapshot(): readonly RetainedItem[]
  /** Count of retained items. */
  size(): number
}

/** Default retention cap — a bounded ring so a long session's subagent churn
 *  cannot grow the store without bound (parity with the ProjectsKb / ci-finding
 *  ring stores). Oldest first-seen id evicted first. */
export const DEFAULT_ITEM_STORE_CAP = 200

/** Build a fresh bounded {@link ItemStore}. `cap` bounds the number of distinct
 *  `itemId`s retained (oldest-evicted). */
export const createItemStore = (cap: number = DEFAULT_ITEM_STORE_CAP): ItemStore => {
  // Insertion-ordered map keyed by itemId. A Map preserves first-insert order on
  // iteration, which is exactly the stable render order we want; re-setting an
  // existing key (a `completed` replacing a `started`) keeps its ORIGINAL slot.
  const items = new Map<string, RetainedItem>()

  const retain = (core: ItemStreamCore): void => {
    // `delta` cores are transient in-flight fragments; the fleet producer emits
    // only `started` / `completed`, so we retain those two lifecycle points and
    // ignore deltas (they would churn the ring with no rendered value).
    if (core.phase === "delta") return
    const next: RetainedItem = {
      itemId: core.itemId,
      itemType: core.itemType,
      phase: core.phase,
      ...(core.phase === "completed" && core.text !== undefined ? { text: core.text } : {}),
    }
    items.set(core.itemId, next)
    // Oldest first-seen id evicted first once over the cap.
    while (items.size > cap) {
      const oldest = items.keys().next().value
      if (oldest === undefined) break
      items.delete(oldest)
    }
  }

  return {
    capture: retain,
    snapshot: () => [...items.values()],
    size: () => items.size,
  }
}

/** Parse the L0→L2 drilldown detail (status/turns/description) from a completed
 *  item's JSON body into a one-line summary. Non-JSON / empty ⇒ undefined (the
 *  caller keeps the phase default — a foreign sink source must never throw). */
const parseItemDetail = (text: string): string | undefined => {
  let body: { status?: unknown; turns?: unknown; description?: unknown }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    return undefined
  }
  const parts: string[] = []
  if (typeof body.status === "string") parts.push(body.status)
  if (typeof body.turns === "number") parts.push(`${body.turns} turn${body.turns === 1 ? "" : "s"}`)
  if (typeof body.description === "string" && body.description !== "") parts.push(body.description)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

/** One rendered row per retained subagent item. `started` ⇒ a live `●` spinner
 *  glyph; `completed` ⇒ a settled `○` with a short drilldown (status/turns) read
 *  from the fleet producer's JSON body. The join key `item-subagent-<id>` is
 *  shown verbatim so the row lines up with the wire-plane item taxonomy. */
const renderItemRow = (it: RetainedItem): string => {
  const glyph = it.phase === "completed" ? "○" : "●"
  const fallback = it.phase === "completed" ? "settled" : "running"
  const detail = (it.text !== undefined ? parseItemDetail(it.text) : undefined) ?? fallback
  return `  ${glyph} ${it.itemType} ${it.itemId} — ${detail}`
}

/** Render the bounded item-store snapshot as a `/activity` "Subagent items"
 *  section. Returns "" for an empty store so the caller appends nothing
 *  (byte-identical when `QUANTA_ITEM_STREAM` is off / no items captured). */
export const renderItemSection = (items: readonly RetainedItem[]): string => {
  if (items.length === 0) return ""
  const header = `Subagent items — ${items.length} row${items.length === 1 ? "" : "s"} (QUANTA_ITEM_STREAM):`
  return [header, ...items.map(renderItemRow)].join("\n")
}
