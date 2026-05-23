/**
 * Pure git merge-conflict parser — implementation.
 *
 * Algorithm summary (mirrors ADR-0111 §결정):
 *
 *   1. Split `source` into per-line records that record start-offset and
 *      terminator length per line — necessary to keep `endOffset` math correct
 *      under mixed CR/CRLF terminators.
 *   2. Scan lines top-level. For every line at column 0 that LOOKS like a
 *      marker (run of `<`/`=`/`>`/`|` of length 5+) classify it.
 *   3. On a valid open (run length ∈ {6,7,8} followed by EOL or " <label>"),
 *      run an inner scan to find the matching landmarks: optional base
 *      (`|||||||` of THE SAME LENGTH as the open), a separator (`=======` of
 *      THE SAME LENGTH), and a close (`>>>>>>>` of THE SAME LENGTH).
 *   4. Mismatched-length marker mid-block (e.g. open=7 but close=8) →
 *      `marker_at_offset` diagnostic, block abandoned, scan resumes after the
 *      open (so the rest of the file is still inspected for valid conflicts).
 *   5. Nested open (a second `<<<<<<<` of any tolerated length before the
 *      first close) → `nested` diagnostic at the second open's line, the FIRST
 *      conflict is abandoned (NOT partially emitted), and scanning continues
 *      from AFTER the second open.
 *   6. Open with no close before EOF → `unterminated` at line `lineCount + 1`.
 *   7. Open + close but no `=======` between → `no_separator`, block abandoned.
 *   8. Orphan close (no preceding open) → `missing_ours` at that line.
 *   9. Orphan separator (no preceding open) → `missing_theirs` at that line.
 *  10. A run of `<<<<<<<` of length 5 or ≥ 9 is NOT a marker — passed as plain
 *      text. (Git tolerates 6, 7, 8 in real merges; outside that band is
 *      overwhelmingly something else.)
 *
 * The parser is a small state machine + line-record scanner: each helper stays
 * under biome's cognitive-complexity cap.
 */

import type {
  ConflictBlock,
  ConflictMarkerStyle,
  ConflictParseDiagnostic,
  ConflictParseResult,
} from "./types"
import { ConflictParserInputError } from "./types"

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
  const diagnostics: ConflictParseDiagnostic[] = []
  let baseIdx = -1
  let baseLabel: string | undefined
  let sepIdx = -1

  for (let j = startIdx + 1; j < lines.length; j++) {
    const rec = lines[j]
    if (!rec) continue
    const m = classifyLine(rec.text)

    // Nested open of ANY tolerated length → abandon block.
    if (m.kind === "open") {
      diagnostics.push({
        kind: "nested",
        line: rec.lineNumber,
        message: `nested '<<<<<<<' open marker at line ${rec.lineNumber} while previous conflict is still open`,
      })
      // Resume AFTER the second open so the outer loop doesn't re-classify it.
      return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "nested")
    }
    if (m.kind === "open_malformed") {
      // Treat like a malformed-marker mid-block: abandon block but record diag.
      diagnostics.push({
        kind: "marker_at_offset",
        line: rec.lineNumber,
        message: `malformed open marker at line ${rec.lineNumber}: expected '<<<<<<< <label>' (with a single space before label)`,
      })
      return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
    }

    // base marker — accepted ONLY before separator AND only matching open length.
    if (m.kind === "base") {
      if (sepIdx !== -1 || baseIdx !== -1) {
        // A second `|||` after the separator or after another base is malformed.
        diagnostics.push({
          kind: "marker_at_offset",
          line: rec.lineNumber,
          message: `unexpected base marker at line ${rec.lineNumber}`,
        })
        return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
      }
      if (m.runLen !== openRunLen) {
        diagnostics.push({
          kind: "marker_at_offset",
          line: rec.lineNumber,
          message: `base marker length ${m.runLen} at line ${rec.lineNumber} does not match open length ${openRunLen}`,
        })
        return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
      }
      baseIdx = j
      baseLabel = m.label
      continue
    }
    if (m.kind === "base_malformed") {
      diagnostics.push({
        kind: "marker_at_offset",
        line: rec.lineNumber,
        message: `malformed base marker at line ${rec.lineNumber}`,
      })
      return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
    }

    if (m.kind === "sep") {
      if (sepIdx !== -1) {
        // Two separators in one block → malformed.
        diagnostics.push({
          kind: "marker_at_offset",
          line: rec.lineNumber,
          message: `unexpected second separator at line ${rec.lineNumber}`,
        })
        return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
      }
      if (m.runLen !== openRunLen) {
        diagnostics.push({
          kind: "marker_at_offset",
          line: rec.lineNumber,
          message: `separator length ${m.runLen} at line ${rec.lineNumber} does not match open length ${openRunLen}`,
        })
        return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
      }
      sepIdx = j
      continue
    }
    if (m.kind === "sep_malformed") {
      // A `=======xyz` style — overwhelmingly NOT a separator (markdown / etc).
      // Don't abandon block on this; treat as plain content.
      continue
    }

    if (m.kind === "close") {
      if (m.runLen !== openRunLen) {
        diagnostics.push({
          kind: "marker_at_offset",
          line: rec.lineNumber,
          message: `close marker length ${m.runLen} at line ${rec.lineNumber} does not match open length ${openRunLen}`,
        })
        return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
      }
      return {
        baseIdx,
        ...(baseLabel !== undefined ? { baseLabel } : {}),
        sepIdx,
        closeIdx: j,
        closeLabel: m.label,
        lengthMismatch: false,
        nested: false,
        resumeAt: j + 1,
        diagnostics,
      }
    }
    if (m.kind === "close_malformed") {
      diagnostics.push({
        kind: "marker_at_offset",
        line: rec.lineNumber,
        message: `malformed close marker at line ${rec.lineNumber}: expected '>>>>>>> <label>' (with a single space before label)`,
      })
      return fail({ baseIdx, sepIdx, diagnostics }, j + 1, "length")
    }
    // m.kind === "none" → plain line, keep scanning.
  }

  // EOF without close.
  return {
    baseIdx,
    ...(baseLabel !== undefined ? { baseLabel } : {}),
    sepIdx,
    closeIdx: -1,
    closeLabel: "",
    lengthMismatch: false,
    nested: false,
    resumeAt: lines.length,
    diagnostics,
  }
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

/** Inspect `lines[idx]` at top-level. */
const classifyTopLevel = (lines: ReadonlyArray<LineRec>, idx: number): TopLevelStep => {
  const line = lines[idx]
  if (!line) return { diagnostics: [], nextIdx: idx + 1 }

  const m = classifyLine(line.text)

  if (m.kind === "open") {
    const scan = scanBlockBody(lines, idx, m.runLen)

    if (scan.closeIdx === -1) {
      // Three sub-cases: nested, length-mismatch (already diagnosed), or EOF.
      if (!scan.nested && !scan.lengthMismatch) {
        // EOF without close → unterminated.
        return {
          diagnostics: [
            ...scan.diagnostics,
            {
              kind: "unterminated",
              line: lines.length + 1,
              message: `unterminated conflict: open marker at line ${line.lineNumber} has no matching '>>>>>>>' before EOF`,
            },
          ],
          nextIdx: scan.resumeAt,
        }
      }
      // Nested / length-mismatch: spec says "resume scanning from after the
      // second open" / "resume after the open" — `scan.resumeAt` already encodes that.
      return { diagnostics: scan.diagnostics, nextIdx: scan.resumeAt }
    }

    if (scan.sepIdx === -1) {
      return {
        diagnostics: [
          ...scan.diagnostics,
          {
            kind: "no_separator",
            line: line.lineNumber,
            message: `conflict at line ${line.lineNumber} has open and close markers but no '=======' separator between them`,
          },
        ],
        nextIdx: scan.resumeAt,
      }
    }

    const block = buildBlock(lines, idx, m.label, scan)
    if (!block) return { diagnostics: scan.diagnostics, nextIdx: scan.resumeAt }
    return { block, diagnostics: scan.diagnostics, nextIdx: scan.resumeAt }
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
