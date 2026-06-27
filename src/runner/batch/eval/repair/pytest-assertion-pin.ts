/**
 * jun-28 repair-effectiveness lever (audit #2): the repair seed feeds the agent a
 * byte-truncated tail (last ~2000 chars) of the validator output. For pytest that
 * tail usually captures the trailing summary + warnings and CUTS OFF the actual
 * `FAILURES` block — the `E   assert X == Y` / `E   AssertionError: …` lines that
 * say WHAT the test demands. So the repair agent is asked to fix a failure whose
 * defining assertion it cannot see, and it keeps shipping the same over-narrow
 * patch. This extractor PINS the pytest failure region (the assertion detail + the
 * `FAILED …` summary) at the FRONT of the tail so the agent sees the target.
 *
 * Pure + deterministic. Falls back to the plain byte-tail when the output has no
 * pytest failure markers (non-pytest validators, collection-only errors), so it is
 * a strict no-op there. Default-OFF at the call site (knob) ⇒ byte-identical.
 */

/** A line pytest emits inside a failure's longrepr (the assertion detail). */
const isAssertionDetailLine = (line: string): boolean =>
  /^E\s/.test(line) || // pytest prefixes longrepr lines with "E   "
  /:\d+:\s*(AssertionError|Error|Exception)\b/.test(line) // "path:line: AssertionError"

/** The `= FAILURES =` banner that opens pytest's detailed failure section. */
const isFailuresBanner = (line: string): boolean => /^=+\s*FAILURES\s*=+/.test(line)
/** The `= short test summary info =` banner that closes it. */
const isSummaryBanner = (line: string): boolean => /^=+\s*short test summary/.test(line)
/** A `FAILED path::test - reason` one-liner from the short summary. */
const isFailedSummaryLine = (line: string): boolean => /^FAILED\s/.test(line)

const lastChars = (s: string, max: number): string => (s.length <= max ? s : s.slice(-max))

/** True when the blob looks like pytest failure output (so pinning is meaningful).
 *  Lets the caller keep its legacy byte-tail trim for non-pytest validators ⇒ the
 *  pin is byte-identical everywhere it would be a no-op. */
export const hasPytestFailureMarkers = (text: string): boolean =>
  text.split("\n").some((l) => isFailuresBanner(l) || isFailedSummaryLine(l) || isAssertionDetailLine(l))

/**
 * Return a failure tail that LEADS with the pytest assertion region (when present)
 * within `maxChars`, then fills the remaining budget with the plain byte-tail for
 * surrounding context. No pytest markers ⇒ return the plain byte-tail unchanged.
 */
export const pinPytestAssertion = (combined: string, maxChars: number): string => {
  if (combined.length <= maxChars) return combined
  const lines = combined.split("\n")

  // 1) The detailed FAILURES block (banner → summary banner), which holds the
  //    `E   assert …` longrepr. Bounded so a huge multi-failure block can't eat
  //    the whole budget.
  const failuresStart = lines.findIndex(isFailuresBanner)
  const failuresBlock: string[] = []
  if (failuresStart >= 0) {
    for (let i = failuresStart; i < lines.length && !isSummaryBanner(lines[i] ?? ""); i += 1) {
      failuresBlock.push(lines[i] ?? "")
    }
  }
  // 2) The `FAILED …` summary one-liners (concise expected/actual reason).
  const failedSummary = lines.filter(isFailedSummaryLine)
  // 3) Loose assertion-detail lines (fallback when there is no FAILURES banner but
  //    pytest still printed `E   …` lines — e.g. `-q` output).
  const looseAssertions = failuresStart >= 0 ? [] : lines.filter(isAssertionDetailLine)

  const pinnedParts = [failuresBlock.join("\n"), looseAssertions.join("\n"), failedSummary.join("\n")]
    .filter((p) => p.trim() !== "")
  if (pinnedParts.length === 0) return lastChars(combined, maxChars) // not pytest ⇒ no-op

  const pinned = lastChars(pinnedParts.join("\n"), maxChars) // assertion region wins the budget
  // Fill the rest with the recent byte-tail for context, marked so the two regions
  // are not mistaken for one continuous block. The assertion leads, so a final cap
  // to `maxChars` trims the trailing CONTEXT (never the pinned assertion).
  const withContext = `${pinned}\n--- recent output tail ---\n${lastChars(combined, maxChars)}`
  return withContext.length <= maxChars ? withContext : withContext.slice(0, maxChars)
}
