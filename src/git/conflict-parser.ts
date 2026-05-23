/**
 * Pure git merge-conflict parser (ADR-0111 — SOTA++ git ecosystem absorption,
 * cursor-git.md §⑧ fix-merge-conflicts skill prerequisite).
 *
 * # Why this exists
 *
 * Skills and tools that need to programmatically inspect merge conflicts in a
 * file currently have two bad choices: shell out to git (slow, requires real
 * repo state, conflates parse with policy), or hand-roll a string scan every
 * time. This module is the typed-and-tested parser shared by all of them.
 *
 * A future `fix-merge-conflicts` skill (or a git tool) takes the file contents
 * (already on disk, the agent just `Read` them), feeds the string here, and
 * works on the typed {@link ConflictBlock}[] — no second I/O, no git binary,
 * no ambiguity about marker shape.
 *
 * # Default-OFF
 *
 * Nobody in the loop imports this file today. A future skill / tool opts in by
 * importing {@link parseConflicts}. Adoption is a one-line wrap.
 *
 * # Contract
 *
 *  1. **Pure.** No I/O, no `Buffer`, no `child_process`. Input is a `string`
 *     (the entire file contents), output is the typed {@link ConflictParseResult}.
 *     The parser does NOT consult the filesystem to verify the conflict is
 *     real — that is the caller's concern.
 *  2. **No-throw.** Malformed conflicts produce a typed
 *     {@link ConflictParseDiagnostic} on the result, NEVER a throw. The ONLY
 *     thrown exception is {@link ConflictParserInputError}, raised when the
 *     input is not a string (a programmer bug — not a domain failure).
 *  3. **exactOptionalPropertyTypes.** Optional fields (`base`, `baseLabel`)
 *     are OMITTED from the block, never set to `undefined`. The condition-set
 *     spread pattern is used at the construction site.
 *  4. **Plane-clean.** Imports nothing from `@/agent`, `@/tool`,
 *     `@/permission`, etc. Only `@/shared` (for the {@link QuantaError}
 *     base class).
 *  5. **Segment-anchored markers.** A marker is recognised ONLY when it sits
 *     at column 0 of a line. A literal `<<<<<<< ` inside a string literal
 *     or comment that happens to begin a line WILL match — the parser is NOT
 *     language-aware. This is a deliberate limitation; document it on the
 *     caller side (the typical caller is `git ls-files -u` output, where the
 *     limitation is irrelevant).
 *
 * # Markers
 *
 * Per git convention (`merge.conflictStyle` = `merge` or `diff3`):
 *
 *   - `<<<<<<< <label>`  start of `ours` (7+ `<`, then a single space, then the label)
 *   - `||||||| <label>`  start of `base` (diff3/three-way only)
 *   - `=======`          separator (7+ `=`, no label after)
 *   - `>>>>>>> <label>`  end of `theirs`
 *
 * Marker lengths >= 7 are accepted (git emits exactly 7 by default; some
 * higher-conflict-depth merges emit more). Marker lengths < 7 are rejected.
 * A marker that lacks the trailing space (e.g. `<<<<<<<HEAD`) is reported as
 * {@link ConflictParseDiagnostic} `marker_at_offset` and the block at that
 * position is dropped (its boundary cannot be trusted).
 *
 * # Style discrimination
 *
 *  - `two-way`   `<<<` / `===` / `>>>` only (no base section)
 *  - `three-way` `<<<` / `|||` / `===` / `>>>` (git's default `merge` style
 *                tracks the merge base but doesn't render it; we still emit
 *                this label when the `|||` line is present)
 *  - `diff3`     Same shape as `three-way`. We expose both literals so callers
 *                that distinguish on `merge.conflictStyle = diff3` (where the
 *                base section is verbose) have the vocabulary; today the
 *                parser maps any `|||`-bearing block to `three-way` (the
 *                conservative choice). `diff3` is reserved for a future
 *                heuristic — kept in the union for forward-compat.
 *
 * # Nested conflicts
 *
 * A `<<<<<<< ` encountered while a conflict is still open is recorded as a
 * `nested` {@link ConflictParseDiagnostic}, but the OUTER block is still
 * emitted: the nested markers ride along inside the outer block's `ours`
 * content verbatim. This is the safer choice for callers (you can't lose data
 * by accident) and matches what `git diff --check` reports.
 */

import { QuantaError } from "@/shared"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Closed union of marker styles. `diff3` is reserved for a future heuristic
 *  (verbose merge-base rendering); today's parser emits `two-way` or `three-way`.
 *  Keeping `diff3` in the union avoids a breaking change later. */
export type ConflictMarkerStyle = "two-way" | "three-way" | "diff3"

/** Runtime mirror of the union. Used by callers/tests for exhaustive coverage
 *  assertions without `as const` gymnastics over a string-literal tuple. */
export const ALL_MARKER_STYLES: ReadonlyArray<ConflictMarkerStyle> = [
  "two-way",
  "three-way",
  "diff3",
]

/** One parsed conflict block. */
export interface ConflictBlock {
  /** Discriminator. `two-way` lacks `base`/`baseLabel`; `three-way`/`diff3`
   *  have both (possibly empty). */
  readonly style: ConflictMarkerStyle
  /** Label after the `<<<<<<< ` marker (typically `HEAD`). Preserved verbatim
   *  including any internal whitespace. Empty string when the open marker had
   *  no label at all (rare but tolerated). */
  readonly oursLabel: string
  /** Label after the `>>>>>>> ` marker (typically the merged-in branch name). */
  readonly theirsLabel: string
  /** Label after the `||||||| ` marker. Present for three-way/diff3 only. */
  readonly baseLabel?: string
  /** Content between the open marker and the separator (or the base marker
   *  when present). Trailing newline preserved. May be empty. */
  readonly ours: string
  /** Content between the separator and the close marker. Trailing newline
   *  preserved. May be empty. */
  readonly theirs: string
  /** Content between the base marker and the separator. Present for
   *  three-way/diff3 only. May be empty. */
  readonly base?: string
  /** 1-indexed line of the `<<<<<<<` marker. */
  readonly startLine: number
  /** 1-indexed line of the `>>>>>>>` marker. */
  readonly endLine: number
  /** 0-indexed char offset of the `<` of the open marker. */
  readonly startOffset: number
  /** 0-indexed char offset one past the end of the close-marker line
   *  (exclusive of the trailing line terminator, if any). */
  readonly endOffset: number
}

/** Closed union — extending requires every exhaustive switch to be updated. */
export interface ConflictParseDiagnostic {
  readonly kind:
    | "unterminated" // open marker with no matching `>>>>>>>` reached EOF
    | "no_separator" // open and close present, but `=======` missing between them
    | "marker_at_offset" // marker present but malformed (e.g. no trailing space)
    | "nested" // a second `<<<<<<<` opened while another was still open
    | "missing_ours" // close marker without any preceding open marker
    | "missing_theirs" // separator without any preceding open marker
  /** 1-indexed line where the diagnostic was raised. May equal `lineCount + 1`
   *  when the diagnostic is "ran past EOF" (unterminated). */
  readonly line: number
  /** Human-readable explanation. Stable enough to log; do not pattern-match. */
  readonly message: string
}

export interface ConflictParseResult {
  readonly blocks: readonly ConflictBlock[]
  readonly diagnostics: readonly ConflictParseDiagnostic[]
  /** Convenience: true iff `blocks.length > 0`. The invariant is enforced at
   *  construction so callers can branch on it without an extra `.length` read. */
  readonly hasConflicts: boolean
}

/** Thrown ONLY when the input is not a string. Domain failures (malformed
 *  conflicts) are reported via {@link ConflictParseDiagnostic} instead. */
export class ConflictParserInputError extends QuantaError {
  constructor(message: string) {
    super("conflict_parser_input", message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker regexes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marker matchers — anchored to the START of the string we feed them (we
 * always feed a single line, never the whole document, so `^` here is the
 * line's column 0).
 *
 * The patterns require:
 *   - 7+ of the marker char
 *   - either: a single space followed by an optional label (with at least
 *     one trailing char, possibly all whitespace — the label slot must exist
 *     so that bare `<<<<<<<HEAD` (no space) is rejected as `marker_at_offset`).
 *   - OR end-of-line (for `=======` which has no label).
 *
 * The label capture is greedy and stops at the line end (we strip CR if
 * present before feeding the line to the matcher).
 */
const OPEN_RE = /^<{7,}(?: (.*))?$/
const BASE_RE = /^\|{7,}(?: (.*))?$/
const SEP_RE = /^={7,}$/
const CLOSE_RE = /^>{7,}(?: (.*))?$/

/** A line that STARTS with the marker char run but the regex didn't accept
 *  (e.g. `<<<<<<<HEAD` — no space). Used to emit `marker_at_offset`. */
const OPEN_MALFORMED_RE = /^<{7,}/
const CLOSE_MALFORMED_RE = /^>{7,}/
const BASE_MALFORMED_RE = /^\|{7,}/

// ─────────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of inspecting one top-level (i.e. NOT inside a block scan) line:
 *  optionally a new block, zero-or-more diagnostics, and the index to resume at. */
interface TopLevelStep {
  readonly block?: ConflictBlock
  readonly diagnostics: ConflictParseDiagnostic[]
  readonly next: number
}

/** Inspect `lines[idx]` at top-level: dispatch to {@link parseBlock} for an
 *  open marker, emit `marker_at_offset` for malformed markers, emit
 *  `missing_ours` for an orphan close, advance one line otherwise. Extracted
 *  from `parseConflicts` to keep the top-level loop's cognitive complexity in
 *  check (biome complexity rule). */
const classifyTopLevel = (lines: ReadonlyArray<LineRec>, idx: number): TopLevelStep => {
  const line = lines[idx]
  if (!line) return { diagnostics: [], next: idx + 1 }
  const text = line.text

  if (OPEN_RE.test(text)) {
    const result = parseBlock(lines, idx)
    return result.kind === "ok"
      ? { block: result.block, diagnostics: result.diagnostics, next: result.consumedUntil }
      : { diagnostics: result.diagnostics, next: result.consumedUntil }
  }
  if (OPEN_MALFORMED_RE.test(text)) {
    return {
      diagnostics: [
        {
          kind: "marker_at_offset",
          line: line.lineNumber,
          message: `malformed open marker at line ${line.lineNumber}: expected '<<<<<<< <label>' with a space before the label`,
        },
      ],
      next: idx + 1,
    }
  }
  if (CLOSE_RE.test(text)) {
    return {
      diagnostics: [
        {
          kind: "missing_ours",
          line: line.lineNumber,
          message: `close marker '>>>>>>>' at line ${line.lineNumber} without a preceding '<<<<<<<' open marker`,
        },
      ],
      next: idx + 1,
    }
  }
  if (CLOSE_MALFORMED_RE.test(text)) {
    return {
      diagnostics: [
        {
          kind: "marker_at_offset",
          line: line.lineNumber,
          message: `malformed close marker at line ${line.lineNumber}: expected '>>>>>>> <label>' with a space before the label`,
        },
      ],
      next: idx + 1,
    }
  }
  return { diagnostics: [], next: idx + 1 }
}

/**
 * Parse merge-conflict markers from a file's contents.
 *
 * Pure. Never throws on malformed input — diagnostics are reported in the
 * returned {@link ConflictParseResult}. The ONLY throw path is a non-string
 * argument (treated as a programmer bug).
 */
export const parseConflicts = (source: string): ConflictParseResult => {
  if (typeof source !== "string") {
    throw new ConflictParserInputError(
      `parseConflicts expects a string, got ${source === null ? "null" : typeof source}`,
    )
  }
  if (source.length === 0) {
    return { blocks: [], diagnostics: [], hasConflicts: false }
  }

  const lines = splitLinesWithOffsets(source)
  const blocks: ConflictBlock[] = []
  const diagnostics: ConflictParseDiagnostic[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line) {
      i++
      continue
    }
    const step = classifyTopLevel(lines, i)
    for (const d of step.diagnostics) diagnostics.push(d)
    if (step.block) blocks.push(step.block)
    i = step.next
  }

  // Orphan separators are intentionally NOT flagged at the top level: a bare
  // `=======` is overwhelmingly a markdown horizontal rule or ASCII art, not
  // a conflict residue, so flagging it would be high-noise. `missing_theirs`
  // (the matching diagnostic kind) is reserved for a future caller that wants
  // to enforce stricter shape (e.g. a precommit hook scanning indexed files).

  return Object.freeze({
    blocks: Object.freeze(blocks),
    diagnostics: Object.freeze(diagnostics),
    hasConflicts: blocks.length > 0,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Block parser
// ─────────────────────────────────────────────────────────────────────────────

/** A line + the offsets needed to reconstruct content slices. `text` is the
 *  line WITHOUT its line terminator (CR or CRLF stripped); `termLen` records
 *  how many terminator bytes followed so we can re-add them to ours/theirs
 *  content. */
interface LineRec {
  readonly text: string
  readonly lineNumber: number // 1-indexed
  readonly startOffset: number // offset of first char of text
  readonly termLen: number // 0 (EOF), 1 (\n), or 2 (\r\n)
}

type BlockParse =
  | {
      readonly kind: "ok"
      readonly block: ConflictBlock
      readonly diagnostics: ConflictParseDiagnostic[]
      readonly consumedUntil: number // index AFTER the close-marker line
    }
  | {
      readonly kind: "fail"
      readonly diagnostics: ConflictParseDiagnostic[]
      readonly consumedUntil: number // where to resume the outer scan
    }

/** Output of the inner block scan — indices into `lines` for each landmark,
 *  plus the captured base label and any diagnostics emitted during the scan
 *  (nested markers, malformed `|||` lines). `-1` ⇒ landmark not seen. */
interface BlockScan {
  readonly baseStartIdx: number
  readonly baseLabel?: string
  readonly sepIdx: number
  readonly closeIdx: number
  readonly closeLabel: string
  readonly diagnostics: ConflictParseDiagnostic[]
}

/** Inner scan for one block's landmarks. Splits the nest-tracking out so
 *  {@link parseBlock} stays under biome's cognitive-complexity bar. */
const scanBlockBody = (lines: ReadonlyArray<LineRec>, startIdx: number): BlockScan => {
  const diagnostics: ConflictParseDiagnostic[] = []
  let baseStartIdx = -1
  let baseLabel: string | undefined
  let sepIdx = -1
  let closeIdx = -1
  let closeLabel = ""
  let nestDepth = 0

  for (let j = startIdx + 1; j < lines.length; j++) {
    const rec = lines[j]
    if (!rec) continue
    const t = rec.text

    if (OPEN_RE.test(t)) {
      if (nestDepth === 0) {
        diagnostics.push({
          kind: "nested",
          line: rec.lineNumber,
          message: `nested '<<<<<<<' open marker at line ${rec.lineNumber} while previous conflict is still open`,
        })
      }
      nestDepth++
      continue
    }
    // Inside a nested block: watch only for its matching close. Other markers
    // are opaque content of the OUTER ours/theirs.
    if (nestDepth > 0) {
      if (CLOSE_RE.test(t)) nestDepth--
      continue
    }

    if (sepIdx === -1 && baseStartIdx === -1) {
      const bm = BASE_RE.exec(t)
      if (bm) {
        baseStartIdx = j
        baseLabel = (bm[1] ?? "").trim()
        continue
      }
      if (BASE_MALFORMED_RE.test(t)) {
        diagnostics.push({
          kind: "marker_at_offset",
          line: rec.lineNumber,
          message: `malformed base marker at line ${rec.lineNumber}: expected '||||||| <label>' with a space before the label`,
        })
      }
    }
    if (sepIdx === -1 && SEP_RE.test(t)) {
      sepIdx = j
      continue
    }
    const cm = CLOSE_RE.exec(t)
    if (cm) {
      closeIdx = j
      closeLabel = (cm[1] ?? "").trim()
      break
    }
  }

  return {
    baseStartIdx,
    ...(baseLabel !== undefined ? { baseLabel } : {}),
    sepIdx,
    closeIdx,
    closeLabel,
    diagnostics,
  }
}

const parseBlock = (lines: ReadonlyArray<LineRec>, startIdx: number): BlockParse => {
  const openLine = lines[startIdx]
  if (!openLine) {
    return { kind: "fail", diagnostics: [], consumedUntil: startIdx + 1 }
  }
  const openMatch = OPEN_RE.exec(openLine.text)
  if (!openMatch) {
    // Defensive — the caller already checked, so this branch is unreachable.
    return { kind: "fail", diagnostics: [], consumedUntil: startIdx + 1 }
  }
  const oursLabel = (openMatch[1] ?? "").trim()

  const scan = scanBlockBody(lines, startIdx)
  const diags: ConflictParseDiagnostic[] = [...scan.diagnostics]

  if (scan.closeIdx === -1) {
    diags.push({
      kind: "unterminated",
      line: openLine.lineNumber,
      message: `unterminated conflict: open marker at line ${openLine.lineNumber} has no matching '>>>>>>>' before EOF`,
    })
    return { kind: "fail", diagnostics: diags, consumedUntil: lines.length }
  }
  if (scan.sepIdx === -1) {
    diags.push({
      kind: "no_separator",
      line: openLine.lineNumber,
      message: `conflict at line ${openLine.lineNumber} has open and close markers but no '=======' separator between them`,
    })
    return { kind: "fail", diagnostics: diags, consumedUntil: scan.closeIdx + 1 }
  }

  const oursEndIdx = scan.baseStartIdx !== -1 ? scan.baseStartIdx : scan.sepIdx
  const ours = sliceLines(lines, startIdx + 1, oursEndIdx)
  const base =
    scan.baseStartIdx !== -1 ? sliceLines(lines, scan.baseStartIdx + 1, scan.sepIdx) : undefined
  const theirs = sliceLines(lines, scan.sepIdx + 1, scan.closeIdx)

  const closeLine = lines[scan.closeIdx]
  if (!closeLine) {
    // Shouldn't happen — closeIdx was found in-bounds — but keeps the typing tight.
    return { kind: "fail", diagnostics: diags, consumedUntil: lines.length }
  }

  const style: ConflictMarkerStyle = scan.baseStartIdx !== -1 ? "three-way" : "two-way"
  const endOffset = closeLine.startOffset + closeLine.text.length

  const block: ConflictBlock = {
    style,
    oursLabel,
    theirsLabel: scan.closeLabel,
    ...(scan.baseLabel !== undefined ? { baseLabel: scan.baseLabel } : {}),
    ours,
    theirs,
    ...(base !== undefined ? { base } : {}),
    startLine: openLine.lineNumber,
    endLine: closeLine.lineNumber,
    startOffset: openLine.startOffset,
    endOffset,
  }

  return { kind: "ok", block, diagnostics: diags, consumedUntil: scan.closeIdx + 1 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Line splitter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split `source` into per-line records. Tolerates a mix of `\n` and `\r\n`
 * terminators inside the same string (rare but real — generated files
 * concatenated from different tools).
 *
 * The final record has `termLen: 0` when the source does not end with a line
 * terminator (a conflict that spans EOF). When it DOES end with a terminator,
 * we DO NOT emit a trailing empty line — that matches `String.split` semantics
 * for the common case but matters here because an extra phantom line would
 * confuse `endLine` math.
 */
const splitLinesWithOffsets = (source: string): LineRec[] => {
  const out: LineRec[] = []
  let pos = 0
  let lineNo = 1
  while (pos < source.length) {
    // Find the next \n.
    const nlIdx = source.indexOf("\n", pos)
    if (nlIdx === -1) {
      // No more terminators — last line spans EOF.
      out.push({
        text: source.slice(pos),
        lineNumber: lineNo,
        startOffset: pos,
        termLen: 0,
      })
      pos = source.length
      break
    }
    const hasCR = nlIdx > pos && source.charCodeAt(nlIdx - 1) === 13 /* \r */
    const textEnd = hasCR ? nlIdx - 1 : nlIdx
    out.push({
      text: source.slice(pos, textEnd),
      lineNumber: lineNo,
      startOffset: pos,
      termLen: hasCR ? 2 : 1,
    })
    pos = nlIdx + 1
    lineNo++
  }
  return out
}

/** Reconstruct the substring covered by `lines[fromIdx .. toIdxExclusive)`,
 *  including each line's trailing terminator (so callers see `\n` / `\r\n`
 *  exactly as it appeared in the source). When `from >= to` returns `""`. */
const sliceLines = (lines: ReadonlyArray<LineRec>, from: number, toExclusive: number): string => {
  if (from >= toExclusive) return ""
  let s = ""
  for (let k = from; k < toExclusive; k++) {
    const rec = lines[k]
    if (!rec) continue
    s += rec.text
    if (rec.termLen === 2) s += "\r\n"
    else if (rec.termLen === 1) s += "\n"
    // termLen 0 ⇒ EOF, append nothing
  }
  return s
}
