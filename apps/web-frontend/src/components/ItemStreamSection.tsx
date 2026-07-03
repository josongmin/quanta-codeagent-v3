/**
 * S2 (T01) — ItemStreamSection: renders the folded `item.*` stream as a
 * subagent-activity list (Codex subagent-activity form — one dense row per
 * projected item, a running/completed status dot, an item-type badge, and the
 * accumulated text).
 *
 * Consumes {@link ItemStreamState} from `useItemStream`. Empty / null ⇒ renders
 * `null` (default-OFF: `QUANTA_ITEM_STREAM` OFF ⇒ no frame ⇒ empty state ⇒
 * nothing renders, byte-identical). Matches the app's own `ObservabilityPane`
 * card aesthetic (rounded card, uppercase micro-label header, dense rows) so it
 * is visually coherent with the pane's other sections.
 */

import { memo } from "react"
import type { ItemStreamEntry, ItemStreamState } from "../ws/item-stream-hooks"

const CARD = "rounded-xl border border-line-subtle bg-surface p-3"
const LABEL = "text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary"

/** Status dot — running (amber, pulsing) vs completed (info/emerald). */
const StatusDot = ({ status }: { status: ItemStreamEntry["status"] }): JSX.Element => (
  <span
    aria-hidden="true"
    className={`h-2 w-2 shrink-0 rounded-full ${
      status === "running" ? "animate-pulse bg-warn" : "bg-info"
    }`}
  />
)

const ItemRow = memo(({ item }: { item: ItemStreamEntry }): JSX.Element => (
  <li className="rounded-lg border border-line-subtle bg-surface-raised px-2 py-1.5">
    <div className="flex items-center gap-2">
      <StatusDot status={item.status} />
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-tertiary">
        {item.itemType}
      </span>
      <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-faint">
        {item.status}
      </span>
    </div>
    {item.text.length > 0 ? (
      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-ink-secondary">
        {item.text}
      </p>
    ) : null}
  </li>
))

/**
 * The item-stream section. Empty / null ⇒ renders `null` (default-OFF). Sorted
 * by `itemIndex` (turn order) so rows read top-to-bottom in emission order even
 * though the Map is latest-wins keyed by id.
 */
export const ItemStreamSection = memo(
  ({ state }: { state: ItemStreamState | null }): JSX.Element | null => {
    if (state === null || state.items.size === 0) return null
    const rows = [...state.items.values()].sort((a, b) => a.itemIndex - b.itemIndex)
    return (
      <section className={CARD} data-testid="item-stream-section">
        <h3 className={LABEL}>Activity ({rows.length})</h3>
        <ul className="mt-2 space-y-1.5">
          {rows.map((item) => (
            <ItemRow key={item.itemId} item={item} />
          ))}
        </ul>
      </section>
    )
  },
)
