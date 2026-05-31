/**
 * Canonical git merge-conflict parser (SSOT — T13, audit L9 H13).
 *
 * The single owner of conflict-parsing for the whole codebase. The former
 * tool-layer copy (src/tool/git/conflict-parser) now forwards here. This is
 * the richer, fully-tested implementation (marker-length matching, nested /
 * missing_theirs / unterminated diagnostics) promoted from the tool layer so
 * the library slice owns it and the duplicate can never re-diverge.
 */

import { QuantaError } from "@/shared"

/** Closed union of marker styles. `diff3` is reserved for a future
 *  verbose-merge-base heuristic; today the parser emits `"two-way"` or
 *  `"three-way"` only. The literal is in the union so callers that branch on
 *  `merge.conflictStyle = diff3` keep a stable vocabulary without a future
 *  breaking change. */
export type ConflictMarkerStyle = "two-way" | "three-way" | "diff3"

/** Runtime mirror of the union for exhaustive-coverage assertions. */
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
  /** Text after `<<<<<<< ` on the open line (verbatim, may be `""`). */
  readonly oursLabel: string
  /** Text after `>>>>>>> ` on the close line. */
  readonly theirsLabel: string
  /** Text after `||||||| ` on the base line — present for three-way / diff3
   *  only. OMITTED for two-way (never `undefined`). */
  readonly baseLabel?: string
  /** Content between the open marker and the separator / base marker. */
  readonly ours: string
  /** Content between the separator and the close marker. */
  readonly theirs: string
  /** Content between the base marker and the separator. Present for three-way
   *  / diff3 only. OMITTED for two-way (never `undefined`). */
  readonly base?: string
  /** 1-indexed line of `<<<<<<<`. */
  readonly startLine: number
  /** 1-indexed line of `>>>>>>>`. */
  readonly endLine: number
  /** 0-indexed char offset of the `<` of the open marker. */
  readonly startOffset: number
  /** 0-indexed char offset one past the last char of the close-marker LINE,
   *  exclusive of the trailing line-terminator. So
   *  `source.slice(startOffset, endOffset)` reproduces the conflict block
   *  excluding the trailing newline. */
  readonly endOffset: number
}

/** Closed union — extending requires every exhaustive switch to be updated. */
export interface ConflictParseDiagnostic {
  readonly kind:
    | "unterminated" // open with no `>>>>>>>` reached EOF
    | "no_separator" // open + close but no `=======` between
    | "marker_at_offset" // marker present but malformed (length mismatch, no space, etc.)
    | "nested" // a second `<<<<<<<` opened while another was open
    | "missing_ours" // close marker without preceding open
    | "missing_theirs" // separator without preceding open
  /** 1-indexed; may equal `lineCount + 1` for EOF-overrun. */
  readonly line: number
  /** Human-readable explanation. Stable enough to log; do not pattern-match. */
  readonly message: string
}

export interface ConflictParseResult {
  readonly blocks: ReadonlyArray<ConflictBlock>
  readonly diagnostics: ReadonlyArray<ConflictParseDiagnostic>
}

/** Thrown ONLY when the input isn't a string. Domain failures (malformed
 *  conflicts) are reported via {@link ConflictParseDiagnostic}. */
export class ConflictParserInputError extends QuantaError {
  constructor(message: string) {
    super("conflict_parser_input", message)
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// Line splitter
// ─────────────────────────────────────────────────────────────────────────────

/** Per-line record. `text` excludes the line terminator; `termLen` records how
 *  many terminator bytes followed (0 at EOF, 1 for `\n`, 2 for `\r\n`) so we
 *  can reconstruct content and compute `endOffset` accurately under any mix. */
interface LineRec {
  readonly text: string
  readonly lineNumber: number
  readonly startOffset: number
  readonly termLen: 0 | 1 | 2
}

/** Tolerates `\n`, `\r\n`, mixed; last line may have no terminator (`termLen=0`). */
const splitLinesWithOffsets = (source: string): LineRec[] => {
  const out: LineRec[] = []
  let pos = 0
  let lineNo = 1
  while (pos < source.length) {
    const nlIdx = source.indexOf("\n", pos)
    if (nlIdx === -1) {
      out.push({ text: source.slice(pos), lineNumber: lineNo, startOffset: pos, termLen: 0 })
      return out
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
 *  including each line's trailing terminator (so callers see `\n`/`\r\n`
 *  exactly as it appeared in the source). When `from >= to`, returns `""`. */
const sliceLines = (lines: ReadonlyArray<LineRec>, from: number, toExclusive: number): string => {
  if (from >= toExclusive) return ""
  let s = ""
  for (let k = from; k < toExclusive; k++) {
    const rec = lines[k]
    if (!rec) continue
    s += rec.text
    if (rec.termLen === 2) s += "\r\n"
    else if (rec.termLen === 1) s += "\n"
  }
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker classification
// ─────────────────────────────────────────────────────────────────────────────

/** Tolerated marker lengths. Git emits 7 in the default merge; -X diff3 may
 *  emit 8 in deep nests; some pathological merges emit 6. Outside this band
 *  is NOT a real conflict marker — passed as plain text. */
const TOLERATED_LENGTHS = new Set<number>([6, 7, 8])

/** Lower bound for "looks like a marker char-run that we should classify"
 *  (used to detect malformed cases). Matches the smallest tolerated length so
 *  we don't accidentally diagnose `<<<` heredocs / `===` markdown HRs / `|||`
 *  table separators / etc. as malformed markers. */
const MIN_MARKER_RUN = 6

/** Count the leading run of `ch` at the start of `text`. Returns 0 when the
 *  first char doesn't match. */
const leadingRun = (text: string, ch: string): number => {
  let n = 0
  while (n < text.length && text.charAt(n) === ch) n += 1
  return n
}

/** Tail after a marker run, sans the SINGLE space separator. Returns:
 *   - `{ ok: true, label: "" }` when the line is exactly the marker run (no label)
 *   - `{ ok: true, label: "<label>" }` when the run is followed by " <label>"
 *   - `{ ok: false }` for malformed (no separating space, e.g. `<<<<<<<HEAD`).
 */
type LabelParse = { readonly ok: true; readonly label: string } | { readonly ok: false }

const parseLabel = (text: string, runLen: number): LabelParse => {
  if (text.length === runLen) return { ok: true, label: "" }
  if (text.charAt(runLen) === " ") return { ok: true, label: text.slice(runLen + 1) }
  return { ok: false }
}

/** Classification of a line's leading marker (if any). */
type MarkerLine =
  | { readonly kind: "open"; readonly runLen: number; readonly label: string }
  | { readonly kind: "close"; readonly runLen: number; readonly label: string }
  | { readonly kind: "base"; readonly runLen: number; readonly label: string }
  | { readonly kind: "sep"; readonly runLen: number }
  | { readonly kind: "open_malformed"; readonly runLen: number }
  | { readonly kind: "close_malformed"; readonly runLen: number }
  | { readonly kind: "base_malformed"; readonly runLen: number }
  | { readonly kind: "sep_malformed"; readonly runLen: number }
  | { readonly kind: "none" }

const classifyOpenLike = (text: string, runLen: number): MarkerLine => {
  // A run of `<` shorter than the minimum band, OR length 9+ → not a marker.
  if (runLen < MIN_MARKER_RUN || !TOLERATED_LENGTHS.has(runLen)) return { kind: "none" }
  const lp = parseLabel(text, runLen)
  if (!lp.ok) return { kind: "open_malformed", runLen }
  return { kind: "open", runLen, label: lp.label }
}

const classifyCloseLike = (text: string, runLen: number): MarkerLine => {
  if (runLen < MIN_MARKER_RUN || !TOLERATED_LENGTHS.has(runLen)) return { kind: "none" }
  const lp = parseLabel(text, runLen)
  if (!lp.ok) return { kind: "close_malformed", runLen }
  return { kind: "close", runLen, label: lp.label }
}

const classifyBaseLike = (text: string, runLen: number): MarkerLine => {
  if (runLen < MIN_MARKER_RUN || !TOLERATED_LENGTHS.has(runLen)) return { kind: "none" }
  const lp = parseLabel(text, runLen)
  if (!lp.ok) return { kind: "base_malformed", runLen }
  return { kind: "base", runLen, label: lp.label }
}

const classifySepLike = (text: string, runLen: number): MarkerLine => {
  if (runLen < MIN_MARKER_RUN || !TOLERATED_LENGTHS.has(runLen)) return { kind: "none" }
  // Separator MUST be exactly the marker run, no label.
  if (text.length === runLen) return { kind: "sep", runLen }
  return { kind: "sep_malformed", runLen }
}

/** Classify a line's leading marker (if any). Dispatch by first char. */
const classifyLine = (text: string): MarkerLine => {
  const ch = text.charAt(0)
  if (ch === "<") return classifyOpenLike(text, leadingRun(text, "<"))
  if (ch === ">") return classifyCloseLike(text, leadingRun(text, ">"))
  if (ch === "|") return classifyBaseLike(text, leadingRun(text, "|"))
  if (ch === "=") return classifySepLike(text, leadingRun(text, "="))
  return { kind: "none" }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block-body scanner
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of {@link scanBlockBody}. */
interface BlockScan {
  /** Index of the base marker line, or -1 if not present. */
  readonly baseIdx: number
  readonly baseLabel?: string
  /** Index of the separator line, or -1. */
  readonly sepIdx: number
  /** Index of the close line, or -1 (block didn't close). */
  readonly closeIdx: number
  readonly closeLabel: string
  /** True when a length-mismatched marker was seen — the block is abandoned. */
  readonly lengthMismatch: boolean
  /** True when a nested open was seen — the block is abandoned. */
  readonly nested: boolean
  /** Where the outer loop should resume scanning (always > startIdx). */
  readonly resumeAt: number
  /** Diagnostics emitted during the scan. */
  readonly diagnostics: ConflictParseDiagnostic[]
}

/** Append a fail-scan result. Helper to keep `scanBlockBody` flat. */
const fail = (
  partial: Pick<BlockScan, "baseIdx" | "sepIdx" | "diagnostics">,
  resumeAt: number,
  reason: "length" | "nested",
): BlockScan => ({
  baseIdx: partial.baseIdx,
  sepIdx: partial.sepIdx,
  closeIdx: -1,
  closeLabel: "",
  lengthMismatch: reason === "length",
  nested: reason === "nested",
  resumeAt,
  diagnostics: partial.diagnostics,
})

/** Mutable per-block state used by the body-scan step handlers. */
interface BlockScanState {
  baseIdx: number
  baseLabel: string | undefined
  sepIdx: number
  diagnostics: ConflictParseDiagnostic[]
}

/** Per-line verdict the step handlers return to the outer loop. */
type StepVerdict =
  | { readonly kind: "continue" }
  | { readonly kind: "abandon"; readonly result: BlockScan }
  | { readonly kind: "complete"; readonly result: BlockScan }

/** Build a successful complete-scan result. */
const complete = (state: BlockScanState, closeIdx: number, closeLabel: string): BlockScan => ({
  baseIdx: state.baseIdx,
  ...(state.baseLabel !== undefined ? { baseLabel: state.baseLabel } : {}),
  sepIdx: state.sepIdx,
  closeIdx,
  closeLabel,
  lengthMismatch: false,
  nested: false,
  resumeAt: closeIdx + 1,
  diagnostics: state.diagnostics,
})

/** Build a fail-scan result preserving the partial state. */
const abandon = (state: BlockScanState, resumeAt: number, reason: "length" | "nested"): BlockScan =>
  fail(
    { baseIdx: state.baseIdx, sepIdx: state.sepIdx, diagnostics: state.diagnostics },
    resumeAt,
    reason,
  )

/** Handle a nested open or malformed open inside an active block. */
const handleNestedOrMalformedOpen = (
  state: BlockScanState,
  rec: LineRec,
  j: number,
  malformed: boolean,
): StepVerdict => {
  if (malformed) {
    state.diagnostics.push({
      kind: "marker_at_offset",
      line: rec.lineNumber,
      message: `malformed open marker at line ${rec.lineNumber}: expected '<<<<<<< <label>' (with a single space before label)`,
    })
    return { kind: "abandon", result: abandon(state, j + 1, "length") }
  }
  state.diagnostics.push({
    kind: "nested",
    line: rec.lineNumber,
    message: `nested '<<<<<<<' open marker at line ${rec.lineNumber} while previous conflict is still open`,
  })
  return { kind: "abandon", result: abandon(state, j + 1, "nested") }
}

/** Handle a base marker (`|||||||`) inside the block. */
const handleBase = (
  state: BlockScanState,
  rec: LineRec,
  j: number,
  runLen: number,
  label: string,
  openRunLen: number,
): StepVerdict => {
  if (state.sepIdx !== -1 || state.baseIdx !== -1) {
    state.diagnostics.push({
      kind: "marker_at_offset",
      line: rec.lineNumber,
      message: `unexpected base marker at line ${rec.lineNumber}`,
    })
    return { kind: "abandon", result: abandon(state, j + 1, "length") }
  }
  if (runLen !== openRunLen) {
    state.diagnostics.push({
      kind: "marker_at_offset",
      line: rec.lineNumber,
      message: `base marker length ${runLen} at line ${rec.lineNumber} does not match open length ${openRunLen}`,
    })
    return { kind: "abandon", result: abandon(state, j + 1, "length") }
  }
  state.baseIdx = j
  state.baseLabel = label
  return { kind: "continue" }
}

/** Handle a separator (`=======`) inside the block. */
const handleSep = (
  state: BlockScanState,
  rec: LineRec,
  j: number,
  runLen: number,
  openRunLen: number,
): StepVerdict => {
  if (state.sepIdx !== -1) {
    state.diagnostics.push({
      kind: "marker_at_offset",
      line: rec.lineNumber,
      message: `unexpected second separator at line ${rec.lineNumber}`,
    })
    return { kind: "abandon", result: abandon(state, j + 1, "length") }
  }
  if (runLen !== openRunLen) {
    state.diagnostics.push({
      kind: "marker_at_offset",
      line: rec.lineNumber,
      message: `separator length ${runLen} at line ${rec.lineNumber} does not match open length ${openRunLen}`,
    })
    return { kind: "abandon", result: abandon(state, j + 1, "length") }
  }
  state.sepIdx = j
  return { kind: "continue" }
}

/** Handle a close marker (`>>>>>>>`) inside the block. */
const handleClose = (
  state: BlockScanState,
  rec: LineRec,
  j: number,
  runLen: number,
  label: string,
  openRunLen: number,
): StepVerdict => {
  if (runLen !== openRunLen) {
    state.diagnostics.push({
      kind: "marker_at_offset",
      line: rec.lineNumber,
      message: `close marker length ${runLen} at line ${rec.lineNumber} does not match open length ${openRunLen}`,
    })
    return { kind: "abandon", result: abandon(state, j + 1, "length") }
  }
  return { kind: "complete", result: complete(state, j, label) }
}

/** Step the per-line dispatch — one line of a block scan. */
const stepBlock = (
  state: BlockScanState,
  rec: LineRec,
  j: number,
  openRunLen: number,
): StepVerdict => {
  const m = classifyLine(rec.text)
  switch (m.kind) {
    case "open":
      return handleNestedOrMalformedOpen(state, rec, j, false)
    case "open_malformed":
      return handleNestedOrMalformedOpen(state, rec, j, true)
    case "base":
      return handleBase(state, rec, j, m.runLen, m.label, openRunLen)
    case "base_malformed":
      state.diagnostics.push({
        kind: "marker_at_offset",
        line: rec.lineNumber,
        message: `malformed base marker at line ${rec.lineNumber}`,
      })
      return { kind: "abandon", result: abandon(state, j + 1, "length") }
    case "sep":
      return handleSep(state, rec, j, m.runLen, openRunLen)
    case "sep_malformed":
      // `=======xyz` style — overwhelmingly NOT a separator (markdown / etc).
      // Don't abandon block on this; treat as plain content.
      return { kind: "continue" }
    case "close":
      return handleClose(state, rec, j, m.runLen, m.label, openRunLen)
    case "close_malformed":
      state.diagnostics.push({
        kind: "marker_at_offset",
        line: rec.lineNumber,
        message: `malformed close marker at line ${rec.lineNumber}: expected '>>>>>>> <label>' (with a single space before label)`,
      })
      return { kind: "abandon", result: abandon(state, j + 1, "length") }
    case "none":
      return { kind: "continue" }
    default: {
      const _exhaust: never = m
      void _exhaust
      return { kind: "continue" }
    }
  }
}

/** Build the EOF-reached fall-through result (no close encountered). */
const eofScan = (state: BlockScanState, linesLen: number): BlockScan => ({
  baseIdx: state.baseIdx,
  ...(state.baseLabel !== undefined ? { baseLabel: state.baseLabel } : {}),
  sepIdx: state.sepIdx,
  closeIdx: -1,
  closeLabel: "",
  lengthMismatch: false,
  nested: false,
  resumeAt: linesLen,
  diagnostics: state.diagnostics,
})

/**
 * Scan the body of a conflict that opened at `lines[startIdx]` with the given
 * `openRunLen`. Returns one of:
 *   - closeIdx >= 0 + sepIdx >= 0: complete block (caller emits).
 *   - closeIdx >= 0 + sepIdx === -1: open and close but no `=======`
 *     (caller emits `no_separator`).
 *   - closeIdx === -1 + nested:    nested second open (caller emits `nested`).
 *   - closeIdx === -1 + lengthMismatch: length-mismatched in-block marker.
 *   - closeIdx === -1 + neither:   ran to EOF (caller emits `unterminated`).
 */
const scanBlockBody = (
  lines: ReadonlyArray<LineRec>,
  startIdx: number,
  openRunLen: number,
): BlockScan => {
  const state: BlockScanState = {
    baseIdx: -1,
    baseLabel: undefined,
    sepIdx: -1,
    diagnostics: [],
  }
  for (let j = startIdx + 1; j < lines.length; j++) {
    const rec = lines[j]
    if (!rec) continue
    const verdict = stepBlock(state, rec, j, openRunLen)
    if (verdict.kind === "abandon" || verdict.kind === "complete") return verdict.result
  }
  return eofScan(state, lines.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level scanner
// ─────────────────────────────────────────────────────────────────────────────

/** A single top-level decision. */
interface TopLevelStep {
  readonly block?: ConflictBlock
  readonly diagnostics: ReadonlyArray<ConflictParseDiagnostic>
  readonly nextIdx: number
}

/** Build a `ConflictBlock` from a successful scan. Caller has already
 *  validated `closeIdx !== -1` and `sepIdx !== -1`. */
const buildBlock = (
  lines: ReadonlyArray<LineRec>,
  openIdx: number,
  oursLabel: string,
  scan: BlockScan,
): ConflictBlock | null => {
  const openLine = lines[openIdx]
  const closeLine = lines[scan.closeIdx]
  if (!openLine || !closeLine) return null

  const oursEndIdx = scan.baseIdx !== -1 ? scan.baseIdx : scan.sepIdx
  const ours = sliceLines(lines, openIdx + 1, oursEndIdx)
  const base = scan.baseIdx !== -1 ? sliceLines(lines, scan.baseIdx + 1, scan.sepIdx) : undefined
  const theirs = sliceLines(lines, scan.sepIdx + 1, scan.closeIdx)

  const style: ConflictMarkerStyle = scan.baseIdx !== -1 ? "three-way" : "two-way"
  const endOffset = closeLine.startOffset + closeLine.text.length

  return {
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
}

/** Handle a top-level OPEN marker. Returns the next top-level step. Extracted
 *  from {@link classifyTopLevel} to keep cognitive complexity under the cap. */
const handleOpenAt = (
  lines: ReadonlyArray<LineRec>,
  idx: number,
  openLine: LineRec,
  openLabel: string,
  openRunLen: number,
): TopLevelStep => {
  const scan = scanBlockBody(lines, idx, openRunLen)

  if (scan.closeIdx === -1) {
    // Three sub-cases: nested, length-mismatch (already diagnosed), or EOF.
    if (!scan.nested && !scan.lengthMismatch) {
      return {
        diagnostics: [
          ...scan.diagnostics,
          {
            kind: "unterminated",
            line: lines.length + 1,
            message: `unterminated conflict: open marker at line ${openLine.lineNumber} has no matching '>>>>>>>' before EOF`,
          },
        ],
        nextIdx: scan.resumeAt,
      }
    }
    // Nested / length-mismatch: spec says "resume scanning from after the
    // second open" / "resume after the open" — `scan.resumeAt` encodes that.
    return { diagnostics: scan.diagnostics, nextIdx: scan.resumeAt }
  }

  if (scan.sepIdx === -1) {
    return {
      diagnostics: [
        ...scan.diagnostics,
        {
          kind: "no_separator",
          line: openLine.lineNumber,
          message: `conflict at line ${openLine.lineNumber} has open and close markers but no '=======' separator between them`,
        },
      ],
      nextIdx: scan.resumeAt,
    }
  }

  const block = buildBlock(lines, idx, openLabel, scan)
  if (!block) return { diagnostics: scan.diagnostics, nextIdx: scan.resumeAt }
  return { block, diagnostics: scan.diagnostics, nextIdx: scan.resumeAt }
}

/** Inspect `lines[idx]` at top-level. */
const classifyTopLevel = (lines: ReadonlyArray<LineRec>, idx: number): TopLevelStep => {
  const line = lines[idx]
  if (!line) return { diagnostics: [], nextIdx: idx + 1 }

  const m = classifyLine(line.text)

  if (m.kind === "open") {
    return handleOpenAt(lines, idx, line, m.label, m.runLen)
  }

  if (m.kind === "open_malformed") {
    return {
      diagnostics: [
        {
          kind: "marker_at_offset",
          line: line.lineNumber,
          message: `malformed open marker at line ${line.lineNumber}: expected '<<<<<<< <label>' (with a single space before label)`,
        },
      ],
      nextIdx: idx + 1,
    }
  }
  if (m.kind === "close") {
    return {
      diagnostics: [
        {
          kind: "missing_ours",
          line: line.lineNumber,
          message: `close marker '>>>>>>>' at line ${line.lineNumber} without a preceding '<<<<<<<' open marker`,
        },
      ],
      nextIdx: idx + 1,
    }
  }
  if (m.kind === "close_malformed") {
    return {
      diagnostics: [
        {
          kind: "marker_at_offset",
          line: line.lineNumber,
          message: `malformed close marker at line ${line.lineNumber}: expected '>>>>>>> <label>' (with a single space before label)`,
        },
      ],
      nextIdx: idx + 1,
    }
  }
  if (m.kind === "sep") {
    return {
      diagnostics: [
        {
          kind: "missing_theirs",
          line: line.lineNumber,
          message: `separator '=======' at line ${line.lineNumber} without a preceding '<<<<<<<' open marker`,
        },
      ],
      nextIdx: idx + 1,
    }
  }
  // base/base_malformed/sep_malformed/none at top level → ignore (not in spec).
  return { diagnostics: [], nextIdx: idx + 1 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse merge-conflict markers from a file's contents.
 *
 * Pure, never throws on malformed input (diagnostics on the result instead).
 * The ONLY throw path is a non-string argument → {@link ConflictParserInputError}
 * (treated as a programmer bug).
 */
export const parseConflicts = (source: string): ConflictParseResult => {
  if (typeof source !== "string") {
    throw new ConflictParserInputError(
      `parseConflicts expects a string, got ${source === null ? "null" : typeof source}`,
    )
  }
  if (source.length === 0) {
    return Object.freeze({ blocks: Object.freeze([]), diagnostics: Object.freeze([]) })
  }

  const lines = splitLinesWithOffsets(source)
  const blocks: ConflictBlock[] = []
  const diagnostics: ConflictParseDiagnostic[] = []

  let i = 0
  while (i < lines.length) {
    const step = classifyTopLevel(lines, i)
    for (const d of step.diagnostics) diagnostics.push(d)
    if (step.block) blocks.push(step.block)
    if (step.nextIdx <= i) {
      // Defensive: advancement is invariant. Bail rather than loop forever.
      break
    }
    i = step.nextIdx
  }

  return Object.freeze({
    blocks: Object.freeze(blocks),
    diagnostics: Object.freeze(diagnostics),
  })
}
