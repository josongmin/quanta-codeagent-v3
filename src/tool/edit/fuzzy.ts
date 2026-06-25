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
 *  stored on the line — it is consulted again at splice time from the ORIGINAL
 *  `source` so untouched lines keep their exact bytes (D6 / mixed-EOL fix).
 *  Splitting on `\n` only would leave a trailing `\r` on every CRLF line that the
 *  rungs' `.trim()` then strips, which is fine for COMPARISON but the splice no
 *  longer re-joins the whole array (the source of the mixed-EOL corruption). */
const splitLines = (s: string): string[] => s.split(/\r?\n/)

/** One source line plus the EXACT terminator that followed it in the original
 *  bytes. `eol` is `""` for the final line when the file has no trailing
 *  newline. Concatenating every `content + eol` reproduces `source` verbatim. */
interface SourceLine {
  content: string
  eol: string
}

/** Parse `source` into per-line `{content, eol}` segments preserving each line's
 *  ORIGINAL terminator (`"\r\n"`, `"\n"`, or `""` for a final unterminated
 *  line). This is the byte-faithful counterpart of {@link splitLines}: it never
 *  coerces terminators, so a MIXED-EOL file's lines each keep their own. The
 *  segment array is index-aligned with `splitLines(source)` (same length, same
 *  line boundaries) so a {@link LineSpan} resolved over `splitLines` maps 1:1. */
const parseSourceLines = (source: string): SourceLine[] => {
  const out: SourceLine[] = []
  let i = 0
  const n = source.length
  let contentStart = 0
  while (i < n) {
    const c = source.charCodeAt(i)
    if (c === 0x0a /* \n */) {
      const crlf = i > 0 && source.charCodeAt(i - 1) === 0x0d /* \r */
      const contentEnd = crlf ? i - 1 : i
      out.push({ content: source.slice(contentStart, contentEnd), eol: crlf ? "\r\n" : "\n" })
      i++
      contentStart = i
    } else {
      i++
    }
  }
  // Final line (no trailing newline, or the empty trailing segment after one).
  out.push({ content: source.slice(contentStart), eol: "" })
  return out
}

/** Character offset (into `source`) at which each line STARTS, plus a final
 *  entry equal to `source.length`. `offsets[k]` = sum of `(content+eol).length`
 *  for every line before `k`. Index-aligned with {@link parseSourceLines}. */
const lineCharOffsets = (lines: SourceLine[]): number[] => {
  const offsets: number[] = [0]
  let acc = 0
  for (const ln of lines) {
    acc += ln.content.length + ln.eol.length
    offsets.push(acc)
  }
  return offsets
}

/** Native EOL to use INSIDE the replacement text. The replacement arrives
 *  LF-delimited; its internal newlines adopt the WINDOW's local terminator — the
 *  terminator of the window's first line — falling back to the file's detected
 *  EOL when the window is a single unterminated line. Lines OUTSIDE the window
 *  are never touched (they are sliced verbatim from `source`). */
const windowEol = (source: string, lines: SourceLine[], span: LineSpan): string => {
  const first = lines[span.start]
  if (first !== undefined && first.eol !== "") return first.eol
  return detectEol(source)
}

/**
 * BYTE-PRESERVING fuzzy splice. The matcher resolves a LINE window `[span)`; we
 * map it to its CHARACTER span in the ORIGINAL `source` and splice the
 * replacement there — exactly like the exact path's literal `slice` splice.
 * Every byte OUTSIDE the matched window (including each untouched line's own
 * terminator) is copied verbatim, so a MIXED-EOL file is never whole-file
 * normalized. Only the replacement region's INTERNAL terminators are (re)emitted
 * using the window's local EOL.
 *
 * The window's char span is `[offsets[span.start], offsets[span.end])`, which
 * INCLUDES the terminator that followed the window's last line. We re-emit that
 * trailing terminator after the replacement so line-count-changing edits stay
 * well-formed (the replacement's last line gets the same terminator the window's
 * last line had — `""` when the window ended an unterminated file).
 */
const spliceWindow = (
  source: string,
  lines: SourceLine[],
  offsets: number[],
  span: LineSpan,
  repl: string,
): string => {
  const charStart = offsets[span.start] as number
  const charEnd = offsets[span.end] as number
  const eol = windowEol(source, lines, span)
  const lastEol = (lines[span.end - 1] as SourceLine).eol
  const replText = splitLines(repl).join(eol) + lastEol
  return source.slice(0, charStart) + replText + source.slice(charEnd)
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

/** F3 — reduce a span set to NON-OVERLAPPING windows via deterministic greedy
 *  left-to-right interval selection: sort by start ascending, accept a span only
 *  if its `start >= the end of the last accepted span`, skip every overlapper.
 *  This mirrors the exact `source.split(old)` then re-join semantics, which never
 *  re-scans inside a just-consumed match (line-level analog of `"aaa".split("aa")`
 *  → one match, not two overlapping ones). Pure interval selection — no heuristic,
 *  no threshold. With distinct/separated windows it returns the input unchanged
 *  (every span already starts at/after the previous end), so the legitimate
 *  multi-replace path is byte-identical. */
const selectNonOverlapping = (spans: LineSpan[]): LineSpan[] => {
  const accepted: LineSpan[] = []
  let lastEnd = Number.NEGATIVE_INFINITY
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start >= lastEnd) {
      accepted.push(span)
      lastEnd = span.end
    }
  }
  return accepted
}

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
  const lines = parseSourceLines(source)
  const offsets = lineCharOffsets(lines)
  // Under replace_all, findLineWindows can surface SELF-OVERLAPPING windows
  // (e.g. needle ["a","a"] in ["a","a","a"] → {0,2} AND {1,3}). Splicing each
  // independently corrupts/drops the leftover line; reduce to non-overlapping
  // windows first (F3), mirroring split/join's inherently non-overlapping reps.
  const targets = replaceAll ? selectNonOverlapping(spans) : [spans[0] as LineSpan]
  // Splice from the BOTTOM (highest start first) so earlier char offsets stay
  // valid as the string grows/shrinks — identical to the exact path's
  // bottom-up splice. Each splice is byte-preserving outside its own window, so
  // untouched lines (and their terminators) survive verbatim (D6 mixed-EOL fix).
  const ordered = [...targets].sort((a, b) => b.start - a.start)
  let next = source
  for (const span of ordered) {
    next = spliceWindow(next, lines, offsets, span, newString)
  }
  const count = replaceAll ? targets.length : 1
  return {
    kind: "matched",
    outcome: {
      ok: true,
      message: `Replaced ${count} occurrence(s) via ${strategy} match`,
      next,
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
  const lines = parseSourceLines(source)
  const offsets = lineCharOffsets(lines)
  // Byte-preserving splice (D6 mixed-EOL fix): everything outside the chosen
  // window — including each untouched line's own terminator — is copied verbatim.
  const next = spliceWindow(source, lines, offsets, best.span, newString)
  return {
    kind: "matched",
    outcome: {
      ok: true,
      message: `Replaced 1 occurrence(s) via scored-candidate best match (exact-anchor ${best.score} > ${runnerUp.score})`,
      next,
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
