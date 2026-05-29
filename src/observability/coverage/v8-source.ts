/**
 * V8 coverage source adapter (ADR-0165).
 *
 * Reads a V8-shape coverage JSON produced by `bun test --coverage` /
 * `node --experimental-vm-modules --coverage` and produces a typed
 * {@link CoverageReport} with line + branch + statement breakdowns.
 *
 * V8 JSON schema this adapter accepts:
 *
 * ```json
 * { "result": [
 *     { "scriptId":"1",
 *       "url":"file:///abs/path.ts",
 *       "functions": [
 *         { "ranges": [
 *             { "startOffset": 0, "endOffset": 142, "count": 1 },
 *             { "startOffset": 80, "endOffset": 142, "count": 0 }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * Schema assumption: this is V8's `Profiler.takePreciseCoverage` shape —
 * stable across V8 versions since Node 10. Bun emits the same shape via its
 * built-in coverage reporter (`bun test --coverage`). A future shape drift
 * (e.g. V8 starting to emit per-statement granular ranges) is caught at the
 * `json-malformed` boundary; the adapter does not silently degrade.
 *
 * Plane-clean: imports ONLY `node:fs/promises` + `node:path` + the in-slice
 * port + `errMessage` from `@/shared` (pure helper, no I/O — single-symbol
 * carve-out documented in ADR-0165 §Plane discipline; admits the canonical
 * `errMessage` policy so future R5-shape behaviour patches reach this slice
 * instead of drifting at inline ternaries). No `@/agent`, `@/tool`, `@/llm`.
 * The `MetricSink` integration lives in `./reporter.ts` — this adapter purely
 * transforms bytes → typed report.
 *
 * Branch-count heuristic ACCURACY CLAIM (documented in ADR-0165 §Alternatives):
 *   - We count occurrences of `if|else|while|for|switch|case|? :|&&|||` in
 *     the source TEXT (after a cheap string-literal strip) — not in an AST.
 *   - This OVER-counts when a comment/template-string contains the keyword
 *     and UNDER-counts when a branch construct is built dynamically (rare).
 *   - For threshold-style "are we above 70%?" signals this is adequate; for
 *     audit-grade per-branch enumeration use nyc/istanbul + Babel parser
 *     (out of scope — see ADR-0165 alternatives).
 *
 * Statement-count heuristic: we approximate statementCount === lineCount.
 * Modern style guides forbid multi-statement lines (`a;b;c`), so each
 * non-blank/non-comment line is approximately one statement. The
 * branch+statement signal is a percentage anyway — both numerator and
 * denominator use the same approximation.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errMessage } from "@/shared"
import { CoverageError, type CoverageReport, type CoverageSource, type FileCoverage } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// V8 JSON shape — typed surface for `JSON.parse` output
// ────────────────────────────────────────────────────────────────────────────

interface V8Range {
  readonly startOffset: number
  readonly endOffset: number
  readonly count: number
}

interface V8Function {
  readonly ranges: ReadonlyArray<V8Range>
}

interface V8Script {
  readonly scriptId?: string
  readonly url: string
  readonly functions: ReadonlyArray<V8Function>
}

interface V8CoverageDoc {
  readonly result: ReadonlyArray<V8Script>
}

const isFunctionShape = (f: unknown): boolean => {
  if (typeof f !== "object" || f === null) return false
  const ranges = (f as { ranges?: unknown }).ranges
  return Array.isArray(ranges)
}

const isScriptShape = (s: unknown): boolean => {
  if (typeof s !== "object" || s === null) return false
  const url = (s as { url?: unknown }).url
  if (typeof url !== "string") return false
  const fns = (s as { functions?: unknown }).functions
  if (!Array.isArray(fns)) return false
  for (const f of fns) {
    if (!isFunctionShape(f)) return false
  }
  return true
}

/** Type-guard parse — converts the unknown `JSON.parse` output into a typed
 *  V8CoverageDoc or returns null when the shape diverges. Returning null lets
 *  the caller raise a typed CoverageError with a precise code. */
const parseV8Doc = (raw: unknown): V8CoverageDoc | null => {
  if (typeof raw !== "object" || raw === null) return null
  const result = (raw as { result?: unknown }).result
  if (!Array.isArray(result)) return null
  for (const s of result) {
    if (!isScriptShape(s)) return null
  }
  return raw as V8CoverageDoc
}

// ────────────────────────────────────────────────────────────────────────────
// URL / path filtering
// ────────────────────────────────────────────────────────────────────────────

const FILE_URL_PREFIX = "file://"

/** Normalize `file://...` → absolute path. Returns null when:
 *   - URL is not `file://` (data: / node: / virtual modules)
 *   - the path contains `node_modules` (vendor code, skipped)
 *
 * Node's `url.fileURLToPath` is intentionally NOT used — we want a single
 * heuristic that runs identically across bun + node + a future test harness.
 */
const urlToAbsPath = (url: string): string | null => {
  if (!url.startsWith(FILE_URL_PREFIX)) return null
  const raw = url.slice(FILE_URL_PREFIX.length)
  // POSIX file URLs look like `file:///abs/path` — the slice leaves a leading
  // `/`. Windows file URLs (`file:///C:/...`) keep the drive letter intact.
  // We resolve to canonicalize separators without forcing a real-fs check
  // (the URL points at a script that may have been deleted post-test-run).
  const abs = resolve(raw)
  if (abs.includes("node_modules")) return null
  return abs
}

// ────────────────────────────────────────────────────────────────────────────
// Byte-offset → line mapping
// ────────────────────────────────────────────────────────────────────────────

/** Build a sorted ascending array of byte offsets where each line STARTS.
 *  `lineStarts[i]` = byte offset of (1-indexed) line `i+1`.
 *
 *  Convention: a trailing `\n` at EOF closes the last line but does NOT
 *  introduce an empty line N+1 — so `"a\nb\n"` has 2 lines, not 3. This
 *  matches the `wc -l` / nyc / istanbul behavior most operators expect.
 *  A file with no trailing newline still counts its final partial line. */
const computeLineStarts = (source: string): number[] => {
  if (source.length === 0) return []
  const starts: number[] = [0]
  for (let i = 0; i < source.length - 1; i += 1) {
    if (source.charCodeAt(i) === 0x0a /* \n */) {
      starts.push(i + 1)
    }
  }
  // Final char: if it's a newline, the previous line is closed and we add no
  // new line; if it's NOT a newline, the final partial line is already
  // counted by the loop above (its start was pushed when the previous \n
  // was seen). Special case: file with NO newlines anywhere — `starts = [0]`
  // already covers line 1.
  return starts
}

/** Binary search for the line (1-indexed) containing byte offset `off`. */
const lineFromOffset = (lineStarts: ReadonlyArray<number>, off: number): number => {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    const start = lineStarts[mid]
    if (start === undefined) break
    if (start <= off) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// ────────────────────────────────────────────────────────────────────────────
// Coverage math — V8 ranges → per-line covered/uncovered
// ────────────────────────────────────────────────────────────────────────────

/**
 * V8 emits NESTED ranges: an outer range with `count > 0` may contain inner
 * ranges with `count === 0` carving out the uncovered subregions. The
 * INNER-MOST range that contains a given offset is authoritative.
 *
 * Algorithm: for each line, we ask "is any byte on this line covered by
 * an inner range with count 0?". If yes → uncovered. Else if any range
 * covers any byte → covered. Else (no range touches the line) → uncovered
 * (the V8 reporter omits dead code, but treating an unreached line as
 * uncovered is the safe default — over-counting uncovered favors honest
 * thresholds).
 */
const computeLineCoverage = (
  source: string,
  ranges: ReadonlyArray<V8Range>,
): { covered: Set<number>; uncoveredLines: number[]; lineCount: number } => {
  const lineStarts = computeLineStarts(source)
  const lineCount = lineStarts.length
  // For each line, track the smallest range (by byte width) that touches it.
  // Smaller range = inner = authoritative. We store (rangeWidth, count) per
  // line; an inner range with count===0 overrides an outer one with count>0.
  const lineState = new Map<number, { width: number; count: number }>()
  for (const r of ranges) {
    if (r.endOffset <= r.startOffset) continue
    const width = r.endOffset - r.startOffset
    const startLine = lineFromOffset(lineStarts, r.startOffset)
    const endLine = lineFromOffset(lineStarts, Math.max(r.startOffset, r.endOffset - 1))
    for (let ln = startLine; ln <= endLine; ln += 1) {
      const prior = lineState.get(ln)
      if (prior === undefined || width < prior.width) {
        lineState.set(ln, { width, count: r.count })
      }
    }
  }
  const covered = new Set<number>()
  const uncovered = new Set<number>()
  for (const [ln, st] of lineState) {
    if (st.count > 0) covered.add(ln)
    else uncovered.add(ln)
  }
  return {
    covered,
    uncoveredLines: Array.from(uncovered).sort((a, b) => a - b),
    lineCount,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Branch + statement heuristics
// ────────────────────────────────────────────────────────────────────────────

/** Strip block + line comments AND string-literal contents so the keyword
 *  counter doesn't see `if` inside `"// if (x)"`. Cheap regex pass; we accept
 *  the documented false-positive on template-literal interpolation that
 *  itself contains a branch keyword. */
const stripCommentsAndStrings = (src: string): string => {
  // Strip block comments
  let s = src.replace(/\/\*[\s\S]*?\*\//g, " ")
  // Strip line comments
  s = s.replace(/\/\/[^\n]*/g, " ")
  // Strip double-quoted strings (no multi-line — same line as opener)
  s = s.replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  // Strip single-quoted strings
  s = s.replace(/'(?:\\.|[^'\\\n])*'/g, "''")
  // Strip template literals (no embedded `${}` parse — we just blank them)
  s = s.replace(/`(?:\\.|[^`\\])*`/g, "``")
  return s
}

/** Count branch-like tokens. Each match counts as ONE branch — a single
 *  `if (x) {} else if (y) {} else {}` yields 4 (`if`, `else`, `if`, `else`).
 *  This matches how nyc reports branch counts per ARM (not per construct). */
const countBranches = (stripped: string): number => {
  let count = 0
  // Keywords — word-boundary anchored so `if` doesn't match `iffy`
  const kwRegex = /\b(?:if|else|while|for|switch|case)\b/g
  while (kwRegex.exec(stripped) !== null) count += 1
  // Short-circuit + ternary — non-word; we match the operator pair/character.
  // `&&` and `||` count once each; `??` is treated like `||` for nullishness.
  const opRegex = /(?:&&|\|\||\?\?|\?)/g
  while (opRegex.exec(stripped) !== null) count += 1
  return count
}

/** Branches covered: heuristic — we assume the SAME coverage ratio applies
 *  to branches as to lines (no way to know without an AST). This is the
 *  approximation documented in the ADR; for audit-grade per-branch counts
 *  use nyc/istanbul. */
const branchesCoveredHeuristic = (branchCount: number, linesCovered: number, lineCount: number) => {
  if (branchCount === 0) return 0
  if (lineCount === 0) return branchCount
  const ratio = linesCovered / lineCount
  return Math.round(branchCount * ratio)
}

// ────────────────────────────────────────────────────────────────────────────
// FileCoverage assembly
// ────────────────────────────────────────────────────────────────────────────

const safePercent = (covered: number, total: number): number => {
  if (total === 0) return 100
  const p = (covered * 100) / total
  // Clamp; surface 2-decimal precision (avoid 99.999999 fingerprint drift).
  return Math.max(0, Math.min(100, Math.round(p * 100) / 100))
}

const buildFileCoverage = async (script: V8Script, abs: string): Promise<FileCoverage | null> => {
  let source: string
  try {
    source = await readFile(abs, "utf8")
  } catch {
    // Source file disappeared between test-run and coverage-read; skip
    // silently — the report is best-effort per-file (we don't surface
    // partial-failure as an error so a moved test file doesn't blow up
    // the whole report).
    return null
  }
  const allRanges: V8Range[] = []
  for (const fn of script.functions) {
    for (const r of fn.ranges) allRanges.push(r)
  }
  const { covered, uncoveredLines, lineCount } = computeLineCoverage(source, allRanges)
  const linesCovered = covered.size
  const stripped = stripCommentsAndStrings(source)
  const branchCount = countBranches(stripped)
  const branchesCovered = branchesCoveredHeuristic(branchCount, linesCovered, lineCount)
  const statementCount = lineCount
  const statementsCovered = linesCovered
  return {
    file: abs,
    lineCount,
    linesCovered,
    linesPercent: safePercent(linesCovered, lineCount),
    branchCount,
    branchesCovered,
    branchesPercent: safePercent(branchesCovered, branchCount),
    statementCount,
    statementsCovered,
    statementsPercent: safePercent(statementsCovered, statementCount),
    uncoveredLines,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Totals — weighted by count, NOT by file count
// ────────────────────────────────────────────────────────────────────────────

const computeTotals = (files: ReadonlyArray<FileCoverage>): CoverageReport["totals"] => {
  let lineCount = 0
  let linesCovered = 0
  let branchCount = 0
  let branchesCovered = 0
  let statementCount = 0
  let statementsCovered = 0
  for (const f of files) {
    lineCount += f.lineCount
    linesCovered += f.linesCovered
    branchCount += f.branchCount
    branchesCovered += f.branchesCovered
    statementCount += f.statementCount
    statementsCovered += f.statementsCovered
  }
  return {
    linesPercent: safePercent(linesCovered, lineCount),
    branchesPercent: safePercent(branchesCovered, branchCount),
    statementsPercent: safePercent(statementsCovered, statementCount),
    fileCount: files.length,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter — public surface
// ────────────────────────────────────────────────────────────────────────────

class V8CoverageSource implements CoverageSource {
  async read(coverageJsonPath: string): Promise<CoverageReport> {
    let raw: string
    try {
      raw = await readFile(coverageJsonPath, "utf8")
    } catch (e) {
      throw new CoverageError("io-failed", `coverage: read failed: ${errMessage(e)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new CoverageError("json-malformed", `coverage: invalid JSON: ${errMessage(e)}`)
    }
    const doc = parseV8Doc(parsed)
    if (doc === null) {
      throw new CoverageError("json-malformed", "coverage: not a V8 coverage document")
    }
    if (doc.result.length === 0) {
      throw new CoverageError("no-coverage-data", "coverage: V8 result array is empty")
    }
    const files: FileCoverage[] = []
    for (const script of doc.result) {
      const abs = urlToAbsPath(script.url)
      if (abs === null) continue
      const fc = await buildFileCoverage(script, abs)
      if (fc !== null) files.push(fc)
    }
    return {
      files,
      totals: computeTotals(files),
      generatedAt: Date.now(),
    }
  }
}

/** Construct the default V8 coverage source. */
export const defaultV8CoverageSource = (): CoverageSource => new V8CoverageSource()
