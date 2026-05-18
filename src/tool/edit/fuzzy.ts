import { applyExactEdit, type EditOutcome } from "./exact"

/** Per-line span [start,end) of a contiguous line window inside `lines`. */
interface LineSpan {
  start: number
  end: number
}

/** Collapse internal whitespace runs to a single space and trim the ends. */
const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, " ")

const splitLines = (s: string): string[] => s.split("\n")

/** Rebuild `lines`, replacing the [span) window with `repl`'s own lines. */
const spliceLines = (lines: string[], span: LineSpan, repl: string): string[] => {
  const before = lines.slice(0, span.start)
  const after = lines.slice(span.end)
  return [...before, ...splitLines(repl), ...after]
}

/** Find every contiguous line window in `haystack` whose per-line projection
 *  (via `project`) equals the projected `needle` lines. */
const findLineWindows = (
  haystack: string[],
  needle: string[],
  project: (line: string) => string,
): LineSpan[] => {
  const spans: LineSpan[] = []
  const projNeedle = needle.map(project)
  const n = projNeedle.length
  if (n === 0 || n > haystack.length) return spans
  for (let i = 0; i + n <= haystack.length; i++) {
    let matched = true
    for (let j = 0; j < n; j++) {
      if (project(haystack[i + j] ?? "") !== projNeedle[j]) {
        matched = false
        break
      }
    }
    if (matched) spans.push({ start: i, end: i + n })
  }
  return spans
}

/**
 * Outcome of one strategy attempt:
 *  - `matched`   → applied, the ladder stops with success.
 *  - `ambiguous` → a confident-but-rejected (>1) match: a definitive failure;
 *                  the ladder stops (a more permissive strategy can only be
 *                  *more* ambiguous, so trying it would be misleading).
 *  - `none`      → this strategy found nothing; try the next rung.
 */
type StrategyResult =
  | { kind: "matched"; outcome: EditOutcome }
  | { kind: "ambiguous"; outcome: EditOutcome }
  | { kind: "none" }

/** Apply a set of line-window matches, honouring uniqueness rules. */
const applyWindows = (
  source: string,
  spans: LineSpan[],
  newString: string,
  replaceAll: boolean,
  strategy: string,
): StrategyResult => {
  if (spans.length === 0) return { kind: "none" }
  if (spans.length > 1 && !replaceAll) {
    return {
      kind: "ambiguous",
      outcome: {
        ok: false,
        message: `${strategy} matched ${spans.length} spans; ambiguous (pass replace_all or add context)`,
      },
    }
  }
  const lines = splitLines(source)
  const targets = replaceAll ? spans : [spans[0] as LineSpan]
  // Splice from the bottom so earlier indices stay valid.
  const ordered = [...targets].sort((a, b) => b.start - a.start)
  let next = lines
  for (const span of ordered) {
    next = spliceLines(next, span, newString)
  }
  const count = replaceAll ? spans.length : 1
  return {
    kind: "matched",
    outcome: {
      ok: true,
      message: `Replaced ${count} occurrence(s) via ${strategy} match`,
      next: next.join("\n"),
    },
  }
}

/** Strategy (b): whitespace-flexible — match ignoring leading/trailing
 *  per-line whitespace and collapsing internal runs. */
const tryWhitespaceFlexible = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): StrategyResult => {
  const spans = findLineWindows(splitLines(source), splitLines(oldString), normalizeLine)
  return applyWindows(source, spans, newString, replaceAll, "whitespace-flexible")
}

/** Strategy (c): anchored line-trim — compare oldString lines trimmed against
 *  file lines trimmed (preserves internal whitespace, only trims ends). */
const tryAnchoredTrim = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): StrategyResult => {
  const trim = (line: string): string => line.trim()
  const spans = findLineWindows(splitLines(source), splitLines(oldString), trim)
  return applyWindows(source, spans, newString, replaceAll, "anchored-trim")
}

/**
 * Fuzzy string replacement with a conservative strategy ladder. The first
 * strategy that yields a confident (unique unless `replaceAll`) match wins:
 *
 *  1. exact            — delegates to {@link applyExactEdit} (no duplication).
 *  2. whitespace-flex  — per-line trim + internal-run collapse.
 *  3. anchored-trim    — per-line end-trim only.
 *
 * Ambiguous (>1) fuzzy matches are never applied unless `replaceAll`. When no
 * strategy is confident the function fails with a helpful message: a wrong
 * edit is worse than no edit.
 */
export const applyFuzzyEdit = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditOutcome => {
  if (oldString === newString) {
    return { ok: false, message: "old_string and new_string are identical" }
  }
  if (oldString === "") {
    return { ok: false, message: "old_string must not be empty" }
  }

  const exact = applyExactEdit(source, oldString, newString, replaceAll)
  if (exact.ok) return { ...exact, message: `${exact.message} via exact match` }

  for (const attempt of [tryWhitespaceFlexible, tryAnchoredTrim]) {
    const r = attempt(source, oldString, newString, replaceAll)
    if (r.kind === "matched") return r.outcome
    // An ambiguous match is definitive: a more permissive rung can only be
    // *more* ambiguous, so stop here with the clearest message.
    if (r.kind === "ambiguous") return r.outcome
  }

  return {
    ok: false,
    message:
      "no confident match (exact, whitespace-flexible, and anchored-trim all failed); " +
      "refine old_string — a wrong edit is worse than none",
  }
}
