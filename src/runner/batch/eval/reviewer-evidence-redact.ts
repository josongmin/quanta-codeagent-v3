/**
 * Reviewer-evidence REDACTOR (jun-30 SOTA++ — per-candidate execution evidence
 * for the LLM chooser/reviewer).
 *
 * SRP leaf: ONE job — take a raw validator failure tail (verify-command stdout/
 * stderr) and make it SAFE + BOUNDED to inject into the candidate-selection
 * prompt. It does NOT know about candidates, prompts, or oracles; callers pass a
 * string and a byte bound and get a string back.
 *
 * The no-leak invariant for THIS surface is different from repro-grounding's:
 * here the danger is that a failing test's output (or a stack trace / pytest
 * summary) carries fragments that look like the GOLD patch or the hidden test's
 * expected values. We are conservative — when in doubt, drop:
 *   (a) BOUND length to `maxChars`, TAIL-first (the failing assertion + summary
 *       live at the END of pytest output), prefixing an ellipsis when truncated.
 *   (b) STRIP unified-diff blocks (`diff --git`, `---`/`+++` headers, `@@` hunks,
 *       and the contiguous `+`/`-` body lines that follow) — a diff in the
 *       failure output is the shape of an answer patch and must never reach the
 *       selector prompt.
 *   (c) STRIP conservative answer-key lines: explicit gold/expected-patch markers
 *       and SWE-bench hidden-field names (`FAIL_TO_PASS`, `PASS_TO_PASS`,
 *       `test_patch`). Ordinary `assert x == y` / stderr is PRESERVED — that is
 *       exactly the discriminating signal the reviewer needs.
 *
 * Pure + dependency-free so it is trivially unit-testable and re-usable by the
 * acceptance-adapter (the SOLE caller allowed to mint `failureOutput`, so the
 * field structurally cannot bypass redaction).
 */

/** Lines that, on their own, advertise an answer key. Conservative + anchored so
 *  an ordinary failure line that merely contains the word "expected" survives. */
const ANSWER_KEY_LINE = /^\s*(FAIL_TO_PASS|PASS_TO_PASS|test_patch|gold[_ ]?patch|golden[_ ]?patch)\b/i

/** Start of a unified-diff block. */
const DIFF_START = /^(diff --git |index [0-9a-f]+\.\.|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null))/

/** A hunk header. */
const HUNK_HEADER = /^@@ .* @@/

/** A diff body line (added/removed/context) — only meaningful while inside a block. */
const DIFF_BODY = /^[+\- ]/

/**
 * Strip any unified-diff block from the text. A block begins at a `diff --git` /
 * file header / hunk header and continues through the contiguous run of `+`/`-`/
 * ` ` body lines. A blank line or any non-diff line ends the block. This removes
 * the answer-patch SHAPE while preserving surrounding prose (e.g. a pytest
 * traceback that happens to print a diff).
 */
const stripDiffBlocks = (text: string): string => {
  const lines = text.split("\n")
  const out: string[] = []
  let inDiff = false
  for (const line of lines) {
    if (!inDiff) {
      if (DIFF_START.test(line) || HUNK_HEADER.test(line)) {
        inDiff = true
        continue
      }
      out.push(line)
      continue
    }
    // Inside a diff block: keep consuming header/hunk/body lines.
    if (DIFF_START.test(line) || HUNK_HEADER.test(line) || DIFF_BODY.test(line)) {
      continue
    }
    // Non-diff line ends the block; re-emit it (it is ordinary content).
    inDiff = false
    out.push(line)
  }
  return out.join("\n")
}

/** Drop standalone answer-key marker lines. */
const stripAnswerKeyLines = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !ANSWER_KEY_LINE.test(line))
    .join("\n")

/** Tail-bound: keep the LAST `maxChars`, prefixing a truncation ellipsis. */
const tailBound = (text: string, maxChars: number): string => {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  // Reserve room for the marker so the result still fits maxChars.
  const marker = "…(truncated)\n"
  const keep = Math.max(0, maxChars - marker.length)
  return marker + text.slice(text.length - keep)
}

/**
 * Redact + bound a raw validator failure tail for safe injection into the
 * candidate-selection prompt. Order: strip diff blocks → strip answer-key lines →
 * tail-bound to `maxChars`. Empty / whitespace-only input ⇒ `""` (caller omits
 * the field). NEVER returns a unified-diff block or an answer-key marker line.
 */
export const redactReviewerEvidence = (raw: string, maxChars: number): string => {
  if (typeof raw !== "string" || raw.trim() === "") return ""
  const withoutDiff = stripDiffBlocks(raw)
  const withoutKeys = stripAnswerKeyLines(withoutDiff)
  const bounded = tailBound(withoutKeys, maxChars)
  return bounded.trim() === "" ? "" : bounded
}
