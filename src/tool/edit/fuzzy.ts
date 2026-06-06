import { detectEol } from "./eol"
import { applyExactEdit, type EditOutcome } from "./exact"
import { inAnyRange, type LineRange } from "./line-range"

/** Per-line span [start,end) of a contiguous line window inside `lines`. */
interface LineSpan {
  start: number
  end: number
}

/** H12 — keep only spans whose window STARTS inside a caller-supplied line
 *  range. `span.start` is 0-indexed; ranges are 1-indexed inclusive, so the
 *  membership test is `span.start + 1`. `undefined` / empty ranges ⇒ the spans
 *  are returned unchanged (byte-identical to the unscoped path). */
const filterSpansByRange = (
  spans: LineSpan[],
  ranges: readonly LineRange[] | undefined,
): LineSpan[] => {
  if (ranges === undefined || ranges.length === 0) return spans
  return spans.filter((s) => inAnyRange(s.start + 1, ranges))
}

/** Collapse internal whitespace runs to a single space and trim the ends. */
const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, " ")

/** Split into lines for COMPARISON, dropping the EOL terminator (`\r?\n`) so a
 *  CRLF file's `"foo\r"` reduces to `"foo"`. The original terminator is NOT
 *  stored on the line — the splice phase re-emits the file's detected EOL (D6).
 *  Splitting on `\n` only (the pre-fix behaviour) left a trailing `\r` on every
 *  CRLF line that the rungs' `.trim()` then stripped, so a matched window was
 *  re-joined LF and neighbours stayed CRLF = mixed-EOL corruption. */
const splitLines = (s: string): string[] => s.split(/\r?\n/)

/** Rebuild `lines`, replacing the [span) window with `repl`'s own lines. The
 *  model's `repl` arrives LF-delimited; we split it the same EOL-agnostic way
 *  so the eventual `join(eol)` (in {@link applyWindows}) normalizes the whole
 *  result — including the spliced-in region — to the file's native terminator. */
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
        kind: "ambiguous",
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
      // Join with the file's native EOL so a uniform CRLF file stays CRLF and a
      // uniform LF file stays LF (D6) — the comparison phase dropped the
      // terminator, this is the single place it is restored.
      next: next.join(detectEol(source)),
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
  ranges: readonly LineRange[] | undefined,
): StrategyResult => {
  const spans = filterSpansByRange(
    findLineWindows(splitLines(source), splitLines(oldString), normalizeLine),
    ranges,
  )
  return applyWindows(source, spans, newString, replaceAll, "whitespace-flexible")
}

/** Strategy (c): anchored line-trim — compare oldString lines trimmed against
 *  file lines trimmed (preserves internal whitespace, only trims ends). */
const tryAnchoredTrim = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  ranges: readonly LineRange[] | undefined,
): StrategyResult => {
  const trim = (line: string): string => line.trim()
  const spans = filterSpansByRange(
    findLineWindows(splitLines(source), splitLines(oldString), trim),
    ranges,
  )
  return applyWindows(source, spans, newString, replaceAll, "anchored-trim")
}

/**
 * Score one candidate window against the needle: the COUNT of lines that match
 * the needle line at the same position VERBATIM (character-for-character), not
 * merely after normalization. This is a pure MEASUREMENT — an integer count of
 * an observable property (how many lines the model typed byte-exactly), with no
 * tunable threshold, no decay, no ratio cutoff. Every candidate already matches
 * the needle under the rung's normalization (that is why it is a candidate); the
 * exact-line count tie-breaks them by literal fidelity to what the model wrote.
 */
const exactAnchorScore = (haystack: string[], needle: string[], span: LineSpan): number => {
  let exact = 0
  for (let j = 0; j < needle.length; j++) {
    if ((haystack[span.start + j] ?? "") === needle[j]) exact++
  }
  return exact
}

/**
 * Strategy (d) — ADR-0456 scored-candidate safety net. Runs ONLY after the
 * whitespace-flex / anchored-trim rungs have produced an AMBIGUOUS (2+ window)
 * result that the ladder would otherwise reject outright. We recover the edit
 * IFF a single candidate is the DECISIVE best:
 *
 *   exactly one candidate window has a STRICTLY higher verbatim-exact-line
 *   count than EVERY other candidate window.
 *
 * A tie at the top (two or more candidates share the maximum score) is NOT a
 * decisive best → we keep failing ambiguous, preserving today's safety. This is
 * a strict-ordering discriminator, not a fudge threshold: there is no "score >
 * 0.8" — the rule is "unique strict maximum or fail". The bias is deliberately
 * toward the false-negative (fail, ask the model to retry) over the false-
 * positive (apply to the wrong window), which is the cardinal sin.
 *
 * `replaceAll` never reaches here: under replaceAll a multi-span match is APPLIED
 * (not ambiguous) by `applyWindows`, so the ladder never produces the ambiguous
 * result this rung consumes.
 */
const tryScoredCandidate = (
  source: string,
  oldString: string,
  newString: string,
  ranges: readonly LineRange[] | undefined,
): StrategyResult => {
  const haystack = splitLines(source)
  const needle = splitLines(oldString)
  // Recompute the candidate set the SAME way the ambiguous rungs did. We union
  // the whitespace-flex and anchored-trim projections (deduped by start) so the
  // candidate pool is exactly the windows the ladder already deemed plausible —
  // we never invent a window a normalizing rung wouldn't have surfaced.
  const byStart = new Map<number, LineSpan>()
  for (const project of [normalizeLine, (l: string) => l.trim()]) {
    for (const span of filterSpansByRange(findLineWindows(haystack, needle, project), ranges)) {
      byStart.set(span.start, span)
    }
  }
  const candidates = [...byStart.values()]
  // Only a genuinely ambiguous (2+ candidate) situation is in scope; 0 or 1 is
  // handled (matched/none) by the earlier rungs and must not be touched here.
  if (candidates.length < 2) return { kind: "none" }

  const scored = candidates.map((span) => ({
    span,
    score: exactAnchorScore(haystack, needle, span),
  }))
  let best = scored[0] as { span: LineSpan; score: number }
  let runnerUp: { span: LineSpan; score: number } | undefined
  for (const c of scored.slice(1)) {
    if (c.score > best.score) {
      runnerUp = best
      best = c
    } else if (runnerUp === undefined || c.score > runnerUp.score) {
      runnerUp = c
    }
  }
  // DECISIVE-best rule: the top score must STRICTLY beat the runner-up. A tie at
  // the maximum (best.score === runnerUp.score) is not decisive → stay ambiguous.
  if (runnerUp === undefined || best.score <= runnerUp.score) {
    return { kind: "none" }
  }
  const lines = splitLines(source)
  const next = spliceLines(lines, best.span, newString)
  return {
    kind: "matched",
    outcome: {
      ok: true,
      message: `Replaced 1 occurrence(s) via scored-candidate best match (exact-anchor ${best.score} > ${runnerUp.score})`,
      // Native-EOL join (D6): keep the file uniform after the splice.
      next: next.join(detectEol(source)),
    },
  }
}

/**
 * Fuzzy string replacement with a conservative strategy ladder. The first
 * strategy that yields a confident (unique unless `replaceAll`) match wins:
 *
 *  1. exact            — delegates to {@link applyExactEdit} (no duplication).
 *  2. whitespace-flex  — per-line trim + internal-run collapse.
 *  3. anchored-trim    — per-line end-trim only.
 *  4. scored-candidate — ADR-0456 safety net: when 2-3 surface as AMBIGUOUS,
 *                        recover IFF one window is the strict exact-anchor best.
 *
 * Ambiguous (>1) fuzzy matches are never applied unless `replaceAll` OR a single
 * candidate is the decisive scored best. When no strategy is confident the
 * function fails with a helpful message: a wrong edit is worse than no edit.
 */
export const applyFuzzyEdit = (
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  lineRanges?: readonly LineRange[],
): EditOutcome => {
  if (oldString === newString) {
    return { ok: false, message: "old_string and new_string are identical" }
  }
  if (oldString === "") {
    return { ok: false, message: "old_string must not be empty" }
  }

  const ranges = lineRanges !== undefined && lineRanges.length > 0 ? lineRanges : undefined
  const exact = applyExactEdit(source, oldString, newString, replaceAll, ranges)
  if (exact.ok) return { ...exact, message: `${exact.message} via exact match` }

  for (const attempt of [tryWhitespaceFlexible, tryAnchoredTrim]) {
    const r = attempt(source, oldString, newString, replaceAll, ranges)
    if (r.kind === "matched") return r.outcome
    // An ambiguous match used to be definitive. ADR-0456: before surfacing the
    // failure, give the deterministic scored-candidate rung a chance to RECOVER
    // the edit when exactly one window is the strict exact-anchor best. It only
    // ever returns `matched` (decisive winner) or `none` (no strict winner →
    // keep the ambiguous failure). It never runs under `replaceAll` because that
    // path never produces an ambiguous result (multi-span is applied, not
    // rejected). Falling through to the ambiguous outcome is byte-identical to
    // pre-ADR behavior for every tie / near-tie / no-advantage case.
    if (r.kind === "ambiguous") {
      const scored = tryScoredCandidate(source, oldString, newString, ranges)
      if (scored.kind === "matched") return scored.outcome
      return r.outcome
    }
  }

  return {
    ok: false,
    message:
      "no confident match (exact, whitespace-flexible, and anchored-trim all failed); " +
      "refine old_string — a wrong edit is worse than none",
    kind: "fuzzy-no-confident",
  }
}
