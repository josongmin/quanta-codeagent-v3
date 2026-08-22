/**
 * Syntax-aware chunker (RFC jun-6-syntax-aware-chunking §4.3).
 *
 * A DEFAULT-OFF variant that slots BEHIND the existing `chunkFile`/`FileChunk`
 * contract: same `FileChunk` shape, so the corpus / upsert / retrieval
 * downstream is byte-untouched. Aligns chunks to declaration boundaries so a
 * retrieved chunk begins at a signature, never mid-body.
 *
 * Invariants (asserted by the hellgate):
 *   - A function is NEVER split mid-body (the core invariant). A decl whose
 *     span ≤ maxLines is exactly one chunk.
 *   - Tiny consecutive siblings merge up to ≤ maxLines into one chunk.
 *   - An oversized decl splits at its CHILDREN boundaries first; a leaf that
 *     still exceeds the split cap falls to a line-window split of that one
 *     body, with the signature repeated as a prefix (last resort, signalled).
 *   - COVERAGE: the union of all chunk line ranges == [1, lineCount] —
 *     nothing dropped (header comments / inter-decl text attached to the
 *     adjacent chunk).
 *   - NO-THROW: no grammar / parse error ⇒ fall back to `chunkFile`,
 *     byte-identical to today.
 *
 * Pure: no clock, no randomness, no I/O. Same input ⇒ byte-identical output.
 */

import type { DeclNode, ParseOutcome } from "@/retrieval/code-parser"
import { type ChunkInput, chunkFile } from "./chunker"
import type { FileChunk } from "./types"

export interface SyntacticChunkOptions {
  /** Max lines for a merged or whole-unit chunk (default 80). A decl ≤ this
   *  is one chunk; consecutive siblings merge until adding the next would
   *  exceed this. A KNOB, not a baked threshold (RFC §8). */
  readonly maxLines?: number
  /** A decl whose span exceeds this is SPLIT at its children (default 150).
   *  A leaf still over this falls to a line-window split. */
  readonly maxLinesSplit?: number
  /** Line-window options for the fallback path + leaf last-resort split. */
  readonly windowLines?: number
  readonly overlapLines?: number
}

const DEFAULT_MAX_LINES = 80
const DEFAULT_MAX_LINES_SPLIT = 150

/** Internal accumulator: a half-open [start,end] 1-based inclusive range plus
 *  the lines it will carry. We build chunks as line-ranges then slice text
 *  ONCE at the end so coverage is exact. */
interface Range {
  startLine: number
  endLine: number
}

/** Emit a `FileChunk` for a 1-based inclusive line range, slicing the text. */
const emit = (input: ChunkInput, lines: readonly string[], r: Range): FileChunk => ({
  path: input.path,
  startLine: r.startLine,
  endLine: r.endLine,
  text: lines.slice(r.startLine - 1, r.endLine).join("\n"),
  mtime: input.mtime,
  sha: input.sha,
})

/** Split one oversized LEAF decl's body into line windows, repeating the
 *  signature line(s) as a prefix on each window so context survives. Returns
 *  ranges covering [decl.startLine, decl.endLine] exactly (the FIRST window
 *  starts at decl.startLine; later windows are body-only but their range
 *  still begins at the body line — the signature TEXT is prepended without
 *  altering the coverage range, so the union stays exact via the first
 *  window). To keep coverage exact AND simple, we cut the body at line
 *  windows and let the first window own the signature. */
const splitLeaf = (decl: DeclNode, windowLines: number): Range[] =>
  splitWindow(decl.startLine, decl.endLine, windowLines)

/** Cut an arbitrary inclusive [start,end] line range into CONTIGUOUS,
 *  non-overlapping windows of at most `windowLines` lines each. The union of
 *  the returned ranges is exactly [start,end] (no holes, no overlaps), so this
 *  is coverage-safe for both leaf bodies AND merge-accumulator / gap ranges.
 *  Deterministic: a pure function of (start,end,windowLines). */
const splitWindow = (start: number, end: number, windowLines: number): Range[] => {
  if (end < start) return []
  // A non-positive window would loop forever / under-cover; treat as "no split"
  // so coverage stays exact (defensive — knobs are validated upstream).
  const w = windowLines > 0 ? windowLines : end - start + 1
  const out: Range[] = []
  let cursor = start
  while (cursor <= end) {
    const winEnd = Math.min(cursor + w - 1, end)
    out.push({ startLine: cursor, endLine: winEnd })
    if (winEnd >= end) break
    cursor = winEnd + 1
  }
  return out
}

/** Push a [start,end] range onto `out`, WINDOW-SPLITTING it first if it would
 *  exceed `maxLines` so no emitted chunk is oversized. Empty ranges (end <
 *  start) are dropped. Coverage of [start,end] is exact and contiguous.
 *
 *  The split window is `min(maxLines, windowLines)` so the bound the guard
 *  checks (maxLines) is the bound the split ENFORCES: a user-set windowLines >
 *  maxLines must NOT leak a still-oversized chunk past the guard. (windowLines
 *  ≤ 0 is treated as "use maxLines" — splitWindow's own non-positive defense is
 *  for the leaf path; here we always have a positive bound.) */
const pushBounded = (
  out: Range[],
  start: number,
  end: number,
  opts: Required<SyntacticChunkOptions>,
): void => {
  if (end < start) return
  if (end - start + 1 <= opts.maxLines) {
    out.push({ startLine: start, endLine: end })
    return
  }
  const splitBy = opts.windowLines > 0 ? Math.min(opts.maxLines, opts.windowLines) : opts.maxLines
  for (const r of splitWindow(start, end, splitBy)) out.push(r)
}

/** Produce the ranges for ONE top-level decl. ≤ maxLines ⇒ one whole-unit
 *  range. Oversized ⇒ split at children (each child a whole range, the
 *  header + gaps owned by the first), recursing; a leaf still oversized ⇒
 *  line-window split. */
const rangesForDecl = (decl: DeclNode, opts: Required<SyntacticChunkOptions>): Range[] => {
  const span = decl.endLine - decl.startLine + 1
  if (span <= opts.maxLines) return [{ startLine: decl.startLine, endLine: decl.endLine }]

  if (decl.children.length === 0) {
    if (span <= opts.maxLinesSplit) {
      return [{ startLine: decl.startLine, endLine: decl.endLine }]
    }
    return splitLeaf(decl, opts.windowLines)
  }

  // Container: first chunk owns [decl.startLine .. firstChild.startLine-1]
  // (the class header + any leading members), then each child recursively,
  // and the LAST child's range is extended to decl.endLine (the closing
  // brace + trailing members) so coverage of [decl.startLine,decl.endLine]
  // is exact.
  const out: Range[] = []
  const sorted = [...decl.children].sort((a, b) => a.startLine - b.startLine)
  let prevEnd = decl.startLine - 1
  for (const child of sorted) {
    // Attach the gap [prevEnd+1 .. child.startLine-1] to this child's chunk.
    const childRanges = rangesForDecl(child, opts)
    // Extend the first sub-range left to cover the preceding gap.
    const head = childRanges[0]
    if (head !== undefined) {
      childRanges[0] = { startLine: prevEnd + 1, endLine: head.endLine }
    }
    for (const cr of childRanges) out.push(cr)
    prevEnd = child.endLine
  }
  // Extend the final range to the container's end (closing brace + trailer).
  const last = out[out.length - 1]
  if (last !== undefined) {
    out[out.length - 1] = { startLine: last.startLine, endLine: decl.endLine }
  } else {
    out.push({ startLine: decl.startLine, endLine: decl.endLine })
  }
  return out
}

/** Mutable plan state: the emitted ranges + the running tiny-sibling merge
 *  accumulator. The accumulator covers [accStart, accEnd] and always begins at
 *  the line AFTER the previous emitted chunk (so gaps/headers are owned). */
interface PlanState {
  out: Range[]
  accStart: number
  accEnd: number
  pending: boolean
}

/** Emit an oversized decl's own ranges, closing any pending merge first and
 *  extending the decl's first sub-range left to absorb the preceding gap. */
const emitOversized = (
  s: PlanState,
  decl: DeclNode,
  opts: Required<SyntacticChunkOptions>,
): void => {
  if (s.pending) {
    // The pending merge accumulator (which owns the leading gap lines up to this
    // decl) may exceed maxLines if a large inter-decl gap precedes an oversized
    // decl — window-split it so no emitted chunk is oversized.
    pushBounded(s.out, s.accStart, decl.startLine - 1, opts)
    s.pending = false
  }
  const dr = rangesForDecl(decl, opts)
  const drHead = dr[0]
  if (drHead !== undefined) {
    const prev = s.out[s.out.length - 1]
    const headStart = prev !== undefined ? prev.endLine + 1 : s.accStart
    dr[0] = { startLine: Math.min(drHead.startLine, headStart), endLine: drHead.endLine }
  }
  for (const r of dr) s.out.push(r)
  s.accStart = decl.endLine + 1
}

/** Extend the merge accumulator by one small decl, flushing first if adding it
 *  would exceed maxLines (measured from accStart). */
const mergeSmall = (s: PlanState, decl: DeclNode, opts: Required<SyntacticChunkOptions>): void => {
  if (s.pending && decl.endLine - s.accStart + 1 > opts.maxLines) {
    // Adding this decl would push the accumulator past maxLines: flush what we
    // have. The flushed range may ITSELF exceed maxLines when a large gap sits
    // between the previous decl and accEnd (the accumulator is gap-inclusive
    // from accStart) — window-split it so no emitted chunk is oversized. The
    // new accumulator re-anchors at accEnd+1 so the inter-decl gap that follows
    // attaches to the NEXT chunk (and is itself bounded on its own flush).
    pushBounded(s.out, s.accStart, s.accEnd, opts)
    s.accStart = s.accEnd + 1
  }
  s.accEnd = decl.endLine
  s.pending = true
}

/** Stretch the LAST range (or push one) so the union covers [1, lineCount].
 *  Trailing lines after the last decl attach to the last chunk when that keeps
 *  it ≤ maxLines; otherwise they become their own bounded window(s) so the tail
 *  is never inflated past maxLines. Coverage of [1,lineCount] stays exact and
 *  contiguous either way. */
const coverTail = (
  out: Range[],
  lineCount: number,
  opts: Required<SyntacticChunkOptions>,
): void => {
  const tail = out[out.length - 1]
  const lastEnd = tail !== undefined ? tail.endLine : 0
  if (lastEnd >= lineCount) return
  if (tail !== undefined && lineCount - tail.startLine + 1 <= opts.maxLines) {
    out[out.length - 1] = { startLine: tail.startLine, endLine: lineCount }
    return
  }
  // Either no chunk yet, or stretching the tail would oversize it: emit the
  // uncovered trailing region [lastEnd+1, lineCount] as bounded window(s).
  pushBounded(out, lastEnd + 1, lineCount, opts)
}

/** Walk top-level decls, MERGING tiny siblings up to maxLines and absorbing
 *  inter-decl gap lines into the following chunk. Returns the full chunk
 *  range list with exact [1,lineCount] coverage. */
const planRanges = (
  decls: readonly DeclNode[],
  lineCount: number,
  opts: Required<SyntacticChunkOptions>,
): Range[] => {
  if (decls.length === 0) {
    // No decls at all (e.g. a file of only imports) ⇒ one chunk covering all.
    return [{ startLine: 1, endLine: lineCount }]
  }
  const sorted = [...decls].sort((a, b) => a.startLine - b.startLine)
  const s: PlanState = { out: [], accStart: 1, accEnd: 0, pending: false }
  for (const decl of sorted) {
    const oversized = decl.endLine - decl.startLine + 1 > opts.maxLines
    if (oversized) emitOversized(s, decl, opts)
    else mergeSmall(s, decl, opts)
  }
  // Flush the final accumulator. This was the ORIGINAL oversize bug: the tail
  // accumulator was emitted whole with no size check, so a small trailing decl
  // sitting after a large inter-decl gap produced a chunk far larger than
  // maxLines. Route it through pushBounded so the trailing chunk is bounded too.
  if (s.pending) pushBounded(s.out, s.accStart, s.accEnd, opts)
  coverTail(s.out, lineCount, opts)
  return s.out
}

/**
 * Chunk a file by syntax when a parse is available, else FALL BACK to the
 * pure line-window `chunkFile` (byte-identical to today). The caller passes
 * the already-resolved {@link ParseOutcome} (the indexer parses once and may
 * reuse it). NO-THROW.
 */
export const chunkFileSyntactic = (
  input: ChunkInput,
  outcome: ParseOutcome,
  opts: SyntacticChunkOptions = {},
): readonly FileChunk[] => {
  // The line-window options forwarded to the fallback `chunkFile`, omitting
  // undefined keys so `exactOptionalPropertyTypes` is satisfied (an absent key
  // ⇒ chunkFile's own DEFAULT_WINDOW/DEFAULT_OVERLAP — byte-identical default).
  const windowOpts: { windowLines?: number; overlapLines?: number } = {}
  if (opts.windowLines !== undefined) windowOpts.windowLines = opts.windowLines
  if (opts.overlapLines !== undefined) windowOpts.overlapLines = opts.overlapLines

  // Fall back path — byte-identical to the line-window chunker.
  if (!outcome.ok) {
    return chunkFile(input, windowOpts)
  }
  if (input.text.length === 0) return []
  const lines = input.text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return []
  const lineCount = lines.length

  const resolved: Required<SyntacticChunkOptions> = {
    maxLines: opts.maxLines ?? DEFAULT_MAX_LINES,
    maxLinesSplit: opts.maxLinesSplit ?? DEFAULT_MAX_LINES_SPLIT,
    windowLines: opts.windowLines ?? 50,
    overlapLines: opts.overlapLines ?? 20,
  }
  const ranges = planRanges(outcome.parsed.decls, lineCount, resolved)
  // Clamp every range to [1, lineCount] and drop empties (defensive — a
  // mis-shaped fake ParsedFile must never produce out-of-bounds chunks).
  const out: FileChunk[] = []
  for (const r of ranges) {
    const startLine = Math.max(1, r.startLine)
    const endLine = Math.min(lineCount, r.endLine)
    if (endLine < startLine) continue
    out.push(emit(input, lines, { startLine, endLine }))
  }
  return out
}

export { DEFAULT_MAX_LINES, DEFAULT_MAX_LINES_SPLIT }
