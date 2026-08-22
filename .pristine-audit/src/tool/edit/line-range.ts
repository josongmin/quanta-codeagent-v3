/**
 * edit/line-range — anchor disambiguation by line scope (H12, Cursor
 * `edit_file.line_ranges` parity).
 *
 * WHAT: a pure helper set that constrains the edit search space to one or more
 *       1-indexed inclusive `[start, end]` line ranges. When the caller supplies
 *       NO ranges the edit engine never imports this path — `applyExactEdit` /
 *       `applyFuzzyEdit` stay byte-identical. With ranges, a repeated anchor
 *       (`x` appearing N times) becomes addressable deterministically — "the
 *       occurrence on lines 40-60" — instead of failing `ambiguous` and forcing
 *       another LLM round-trip.
 * NO-THROW: pure measurement only (newline counting + interval membership).
 *
 * Line numbering: 1-indexed, inclusive on both ends (the spelling the model
 * reads in `read`/`grep` output, so it can copy a span verbatim). A multi-line
 * `old_string` is scoped by the line its FIRST character lands on.
 */

/** One inclusive 1-indexed line interval. `start <= end`, both `>= 1`. */
export interface LineRange {
  start: number
  end: number
}

/** 1-indexed line on which byte `index` of `source` lives (newline = U+000A).
 *  `index` is clamped-by-iteration: counting stops at `index`, so an index past
 *  EOF simply counts every newline (last line). Pure, O(index). */
export const lineAt = (source: string, index: number): number => {
  let line = 1
  const stop = Math.min(index, source.length)
  for (let k = 0; k < stop; k++) {
    if (source.charCodeAt(k) === 10) line++
  }
  return line
}

/** True when `line` (1-indexed) falls inside at least one range. Empty ranges
 *  ⇒ false (the caller treats "ranges present but matches nothing" distinctly
 *  from "no ranges supplied"). */
export const inAnyRange = (line: number, ranges: readonly LineRange[]): boolean =>
  ranges.some((r) => line >= r.start && line <= r.end)

/** Non-overlapping start offsets of `needle` in `source` whose FIRST character
 *  lands on a line inside `ranges`. Advances by `needle.length` so the count
 *  matches the engine's `source.split(needle).length - 1` semantics (the same
 *  non-overlapping occurrences the unscoped path counts). `needle` is never
 *  empty here (the engine rejects an empty `old_string` before this is hit). */
export const inRangeMatchOffsets = (
  source: string,
  needle: string,
  ranges: readonly LineRange[],
): number[] => {
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const i = source.indexOf(needle, from)
    if (i < 0) break
    if (inAnyRange(lineAt(source, i), ranges)) offsets.push(i)
    from = i + needle.length
  }
  return offsets
}

/** Validation verdict for a caller-supplied range list. */
export type LineRangeVerdict = { ok: true } | { ok: false; message: string }

/** Reject malformed ranges BEFORE they reach the matcher: each must be a pair
 *  of positive integers with `start <= end`. A bad range is a model error, not
 *  a silent no-op — surfacing it lets the model fix the span rather than wonder
 *  why its edit "found nothing". */
export const validateLineRanges = (ranges: readonly LineRange[]): LineRangeVerdict => {
  for (const r of ranges) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) {
      return {
        ok: false,
        message: `line_ranges entries must be integers; got {start:${r.start}, end:${r.end}}`,
      }
    }
    if (r.start < 1) {
      return { ok: false, message: `line_ranges start must be >= 1 (1-indexed); got ${r.start}` }
    }
    if (r.end < r.start) {
      return { ok: false, message: `line_ranges end (${r.end}) must be >= start (${r.start})` }
    }
  }
  return { ok: true }
}

/** Total line count of `source` (1 for empty / no-newline; counts the trailing
 *  partial line). Used to annotate edit FAILURES so the model can pick a valid
 *  range on retry instead of guessing. */
export const lineCount = (source: string): number => {
  let n = 1
  for (let k = 0; k < source.length; k++) {
    if (source.charCodeAt(k) === 10) n++
  }
  return n
}
