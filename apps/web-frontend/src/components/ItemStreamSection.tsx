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

/** jul-15 — parse a `peerMessage` item's `completed.text` (`from→to [kind] body`,
 *  the projector's `onPeerMessage` format) into its attribution parts. Returns
 *  null for any text that does not match (rendered verbatim as a fallback). */
const PEER_RE = /^(.+?)→(.+?) \[([^\]]+)\] ([\s\S]*)$/
const parsePeerMessage = (
  text: string,
): { from: string; to: string; kind: string; body: string } | null => {
  const m = PEER_RE.exec(text)
  if (m === null) return null
  const [, from, to, kind, body] = m
  if (from === undefined || to === undefined || kind === undefined || body === undefined) return null
  return { from, to, kind, body }
}

/** jul-15 — a surfaced peer / side-agent message rendered as Codex's
 *  "Sent from another task" form: a muted attribution label above a
 *  user-message-style bubble (vs the generic {@link ItemRow}). The body was
 *  already redacted + control-sanitized at the emit boundary, so it renders
 *  verbatim. A text that does not match the projector format falls back to the
 *  raw text in the bubble. */
const PeerMessageRow = memo(({ item }: { item: ItemStreamEntry }): JSX.Element => {
  const parsed = parsePeerMessage(item.text)
  return (
    <li
      className="rounded-lg border border-line-subtle bg-surface-raised px-2 py-1.5"
      data-testid="peer-message-row"
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-tertiary">
        <span aria-hidden="true">✉</span>
        <span>Sent from another task</span>
        {parsed !== null ? (
          <span className="ml-auto normal-case tracking-normal text-ink-faint">
            {parsed.from} → {parsed.to} · {parsed.kind}
          </span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface px-2 py-1 text-[11px] text-ink-secondary">
        {parsed !== null ? parsed.body : item.text}
      </p>
    </li>
  )
})

/**
 * The item-stream section. Empty / null ⇒ renders `null` (default-OFF). Sorted
 * by `itemIndex` (turn order) so rows read top-to-bottom in emission order even
 * though the Map is latest-wins keyed by id. A `peerMessage` item gets the
 * dedicated {@link PeerMessageRow} (Codex "Sent from another task" label+bubble);
 * every other item type gets the generic {@link ItemRow}.
 */
export const ItemStreamSection = memo(
  ({ state }: { state: ItemStreamState | null }): JSX.Element | null => {
    if (state === null || state.items.size === 0) return null
    const rows = [...state.items.values()].sort((a, b) => a.itemIndex - b.itemIndex)
    return (
      <section className={CARD} data-testid="item-stream-section">
        <h3 className={LABEL}>Activity ({rows.length})</h3>
        <ul className="mt-2 space-y-1.5">
          {rows.map((item) =>
            item.itemType === "peerMessage" ? (
              <PeerMessageRow key={item.itemId} item={item} />
            ) : (
              <ItemRow key={item.itemId} item={item} />
            ),
          )}
        </ul>
      </section>
    )
  },
)
