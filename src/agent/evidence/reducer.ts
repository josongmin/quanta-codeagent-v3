/**
 * Evidence reducer (jul-5, SOTA++ P1) — renders the ledger into a COMPACT per-turn
 * digest, not a dump.
 *
 * PHILOSOPHY GUARD: the reducer ORGANIZES (counts, groups, surfaces contradictions,
 * links raw via handles) — it does NOT decide which hypothesis wins. It hands the
 * model a bounded evidence summary + reveal handles; the model still reasons. Bounded
 * by `maxCards` (most-recent window) so a long session never balloons the prompt.
 */

import type { EvidenceLedgerSnapshot } from "./types"

const DEFAULT_MAX_CARDS = 12

const locSuffix = (
  location: EvidenceLedgerSnapshot["cards"][number]["location"],
): string => {
  if (location?.file === undefined) return ""
  const line = location.lineStart !== undefined ? `:${location.lineStart}` : ""
  return ` [${location.file}${line}]`
}

/**
 * Render a bounded evidence digest for injection into the per-turn context. Empty
 * ledger ⇒ `""` (caller emits nothing → byte-identical to no-evidence). Shows the
 * most-recent `maxCards` cards; a contradiction banner leads when tensions exist so
 * the model addresses them first.
 */
export const renderEvidenceDigest = (
  snapshot: EvidenceLedgerSnapshot,
  maxCards: number = DEFAULT_MAX_CARDS,
): string => {
  if (snapshot.total === 0) return ""
  const lines: string[] = []
  const head =
    snapshot.contradictionCount > 0
      ? `Evidence ledger: ${snapshot.total} card(s), ${snapshot.contradictionCount} CONTRADICTION(s) — resolve these first.`
      : `Evidence ledger: ${snapshot.total} card(s).`
  lines.push(head)
  const shown = snapshot.cards.slice(-maxCards)
  if (shown.length < snapshot.total) {
    lines.push(`(showing most recent ${shown.length})`)
  }
  for (const c of shown) {
    const tension = c.contradicts.length > 0 ? " ⚠contradicts" : ""
    const reveal = c.revealHandle !== undefined ? ` (raw:${c.revealHandle})` : ""
    lines.push(`- (${c.source}/${c.confidence})${tension} ${c.claim}${locSuffix(c.location)}${reveal}`)
  }
  return lines.join("\n")
}
