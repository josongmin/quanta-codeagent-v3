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

/** Collapse to a single line — a digest line MUST NOT contain newlines, or a claim /
 *  handle sourced from external tool output could forge extra `- ` rows or break the
 *  enclosing block (adversarial-audit R1 injection finding). Boundary-token defanging
 *  (`<system-reminder>`) remains the wiring's `embedUntrusted` job; this guarantees the
 *  digest's OWN line structure can't be hijacked regardless. */
const oneLine = (s: string): string =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const locSuffix = (location: EvidenceLedgerSnapshot["cards"][number]["location"]): string => {
  if (location?.file === undefined) return ""
  const line = location.lineStart !== undefined ? `:${location.lineStart}` : ""
  return ` [${oneLine(location.file)}${line}]`
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
  // Clamp a non-positive / non-integer bound back to the default — a negative maxCards
  // would flip `slice(-n)` into `slice(n)` (wrong window) and 0 yields "most recent 0".
  const cap = Number.isInteger(maxCards) && maxCards > 0 ? maxCards : DEFAULT_MAX_CARDS
  const lines: string[] = []
  const head =
    snapshot.contradictionCount > 0
      ? `Evidence ledger: ${snapshot.total} card(s), ${snapshot.contradictionCount} CONTRADICTION(s) — resolve these first.`
      : `Evidence ledger: ${snapshot.total} card(s).`
  lines.push(head)
  const shown = snapshot.cards.slice(-cap)
  if (shown.length < snapshot.total) {
    lines.push(`(showing most recent ${shown.length})`)
  }
  for (const c of shown) {
    const tension = c.contradicts.length > 0 ? " ⚠contradicts" : ""
    const reveal = c.revealHandle !== undefined ? ` (raw:${oneLine(c.revealHandle)})` : ""
    lines.push(
      `- (${c.source}/${c.confidence})${tension} ${oneLine(c.claim)}${locSuffix(c.location)}${reveal}`,
    )
  }
  return lines.join("\n")
}
