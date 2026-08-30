/**
 * Istanbul per-branch coverage source adapter (ADR-0173 — Phase 3 of ADR-0165/0170).
 *
 * Third sibling of `v8-source.ts` (ADR-0165) and `ast-source.ts` (ADR-0170).
 * Same {@link CoverageSource} port; same V8 JSON intake; but ALSO does
 * AST-precise per-BRANCH execution counters via V8 byte-range containment —
 * for each AST branch node, we find the smallest enclosing V8 range and copy
 * its `count`. This replaces the line-coverage-RATIO heuristic the prior two
 * adapters fall back on for `branchesCovered` with a true per-branch number.
 *
 * SOTA reference: c8's `v8-to-istanbul` package — Strategy B+C of the research
 * note (V8/JSC native byte coverage + AST containment merge + Istanbul JSON
 * shape output). We mirror its algorithm verbatim against the TS compiler
 * API instead of `@babel/parser`.
 *
 * Plane-clean: imports ONLY `node:fs/promises` + `node:path` + `typescript`
 * + `errMessage` from `@/shared` (pure helper, no I/O — single-symbol
 * carve-out documented in ADR-0165 §Plane discipline; admits the canonical
 * `errMessage` policy so future R5-shape behaviour patches reach this slice
 * instead of drifting at inline ternaries)
 * + the in-slice port + the in-slice AST helper. No `@/agent`, `@/tool`,
 * `@/llm`. The `MetricSink` integration lives in `./reporter.ts`; the
 * Istanbul-shape JSON emitter lives in `./istanbul-shape-emitter.ts` — this
 * adapter purely transforms bytes → typed report with per-branch counts.
 *
 * Bun V8 coverage status (verified 2026-05-25): Bun 1.3.x does NOT honor the
 * standard `NODE_V8_COVERAGE` env var (no `coverage-*.json` files dumped to
 * the directory). The supported intake paths for THIS adapter are:
 *   - `bun test --coverage --coverage-reporter=lcov` converted via `lcov-parse`
 *     externally (lcov has line counts but no byte ranges; degraded mode)
 *   - `node --test --experimental-test-coverage` (Node ≥20 emits V8 JSON)
 *   - `c8 --reporter=json node ...` (V8 JSON written to `./coverage/coverage-*.json`)
 *   - hand-crafted V8-shape JSON (what the hellgate uses)
 * The CALLER chooses the runner; this adapter only ingests V8 JSON. This is
 * documented in ADR-0173 §Bun-V8-status.
 *
 * Short-circuit fidelity policy (`shortCircuitFidelity` option):
 *   V8 does not always carve out the RHS of `&&` / `||` / `??` into its own
 *   byte range — JIT-compiled hot short-circuits may merge with the parent
 *   expression's range. The smallest enclosing range is then the parent's
 *   range; the RHS branch inherits the parent's count. This OVER-counts
 *   RHS coverage (a branch the runtime never short-circuit-evaluated is
 *   recorded as covered).
 *   - `"lenient"` (default): accept the smallest-enclosing fallback; the
 *     `branchesCovered` count is a best-effort upper bound.
 *   - `"strict"`: same numeric output, BUT emit a `shortCircuitWarnings`
 *     count on the report's `_diagnostics` extension so callers can detect
 *     low-fidelity reports.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type * as TypeScript from "typescript"
import { errMessage } from "@/shared"
import { CoverageError, type CoverageReport, type CoverageSource, type FileCoverage } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export interface IstanbulCoverageSourceOpts {
  /** Optional `TypeScript.CompilerOptions` override. Syntactic parse only — same
   *  posture as `ast-source.ts`; the options barely matter beyond pinning
   *  `ScriptTarget`. */
  readonly compilerOptions?: TypeScript.CompilerOptions
  /** Skip pattern for files. Default: `/node_modules\/|\.d\.ts$/`. Mirrors
   *  the AST adapter's secondary guard. */
  readonly skipPattern?: RegExp
  /** Short-circuit fidelity for `&&`/`||`/`??`. See module docstring.
   *  Default: `"lenient"`. */
  readonly shortCircuitFidelity?: "lenient" | "strict"
}

/** Construct the per-branch counter adapter. */
export const istanbulCoverageSource = (opts: IstanbulCoverageSourceOpts = {}): CoverageSource =>
  new IstanbulCoverageSource(opts)

// ────────────────────────────────────────────────────────────────────────────
// V8 JSON shape (duplicated from v8-source.ts — see ADR-0170 §note for why)
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
// URL filtering
// ────────────────────────────────────────────────────────────────────────────

const FILE_URL_PREFIX = "file://"
const DEFAULT_SKIP = /node_modules\/|\.d\.ts$/

const urlToAbsPath = (url: string, skip: RegExp): string | null => {
  if (!url.startsWith(FILE_URL_PREFIX)) return null
  const raw = url.slice(FILE_URL_PREFIX.length)
  const abs = resolve(raw)
  if (skip.test(abs)) return null
  return abs
}

// ────────────────────────────────────────────────────────────────────────────
// Byte-offset → line mapping (identical math to v8-source.ts / ast-source.ts)
// ────────────────────────────────────────────────────────────────────────────

const computeLineStarts = (source: string): number[] => {
  if (source.length === 0) return []
  const starts: number[] = [0]
  for (let i = 0; i < source.length - 1; i += 1) {
    if (source.charCodeAt(i) === 0x0a /* \n */) {
      starts.push(i + 1)
    }
  }
  return starts
}

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

const computeLineCoverage = (
  source: string,
  ranges: ReadonlyArray<V8Range>,
): { covered: Set<number>; uncoveredLines: number[]; lineCount: number } => {
  const lineStarts = computeLineStarts(source)
  const lineCount = lineStarts.length
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
// AST branch enumeration — visitor that collects (kind, pos, end) per arm
// ────────────────────────────────────────────────────────────────────────────

type BranchKind =
  | "if-then"
  | "if-else"
  | "switch-case"
  | "cond-true"
  | "cond-false"
  | "binary-rhs"
  | "loop-body"
  | "catch"

interface BranchSite {
  readonly kind: BranchKind
  /** Byte start offset of the arm. */
  readonly pos: number
  /** Byte end offset of the arm (exclusive). */
  readonly end: number
  /** Whether this arm is short-circuit-prone (RHS of `&&`/`||`/`??` or a
   *  ternary arm). Used by the strict-fidelity diagnostic. */
  readonly shortCircuitProne: boolean
}

const defaultCompilerOptions = (ts: typeof TypeScript): TypeScript.CompilerOptions => ({
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
})

const scriptKindFromPath = (abs: string, ts: typeof TypeScript): TypeScript.ScriptKind => {
  if (abs.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (abs.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (abs.endsWith(".js") || abs.endsWith(".mjs") || abs.endsWith(".cjs")) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

const nodeRange = (
  n: TypeScript.Node,
  sf: TypeScript.SourceFile,
): { pos: number; end: number } => ({
  // `getStart(sf)` skips leading trivia; the V8 ranges are emitted from
  // post-trivia byte offsets, so we use it to match. We pass `sf` explicitly
  // because the parse was done with `setParentNodes=false` (parent pointers
  // disabled to keep the parse cheap), so `n.getStart()` without an explicit
  // sourceFile would crash on `getSourceFileOfNode` lookup.
  pos: n.getStart(sf),
  end: n.getEnd(),
})

/**
 * Walk the AST and collect one BranchSite per ARM. Mirrors the
 * `ast-source.ts` visitor (same kind enumeration) but RECORDS each arm with
 * its byte range instead of just incrementing a counter.
 *
 * String / template-no-substitution / regex literals halt recursion — same
 * policy as the AST adapter.
 */
const enumerateBranches = (sf: TypeScript.SourceFile, ts: typeof TypeScript): BranchSite[] => {
  const sites: BranchSite[] = []

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: closed switch over branch-bearing node kinds; splitting per-kind would obscure the single-pass invariant
  const visit = (node: TypeScript.Node): void => {
    if (
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      return
    }

    switch (node.kind) {
      case ts.SyntaxKind.IfStatement: {
        const ifs = node as TypeScript.IfStatement
        sites.push({
          kind: "if-then",
          ...nodeRange(ifs.thenStatement, sf),
          shortCircuitProne: false,
        })
        if (ifs.elseStatement !== undefined) {
          sites.push({
            kind: "if-else",
            ...nodeRange(ifs.elseStatement, sf),
            shortCircuitProne: false,
          })
        }
        break
      }
      case ts.SyntaxKind.ConditionalExpression: {
        const ce = node as TypeScript.ConditionalExpression
        sites.push({ kind: "cond-true", ...nodeRange(ce.whenTrue, sf), shortCircuitProne: true })
        sites.push({ kind: "cond-false", ...nodeRange(ce.whenFalse, sf), shortCircuitProne: true })
        break
      }
      case ts.SyntaxKind.SwitchStatement: {
        const sw = node as TypeScript.SwitchStatement
        for (const clause of sw.caseBlock.clauses) {
          if (
            clause.kind === ts.SyntaxKind.CaseClause ||
            clause.kind === ts.SyntaxKind.DefaultClause
          ) {
            sites.push({
              kind: "switch-case",
              ...nodeRange(clause, sf),
              shortCircuitProne: false,
            })
          }
        }
        break
      }
      case ts.SyntaxKind.BinaryExpression: {
        const be = node as TypeScript.BinaryExpression
        const op = be.operatorToken.kind
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          // RHS branch (the "did we evaluate the right side?" arm).
          sites.push({ kind: "binary-rhs", ...nodeRange(be.right, sf), shortCircuitProne: true })
        }
        break
      }
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement: {
        const loop = node as
          | TypeScript.ForStatement
          | TypeScript.ForInStatement
          | TypeScript.ForOfStatement
          | TypeScript.WhileStatement
          | TypeScript.DoStatement
        sites.push({
          kind: "loop-body",
          ...nodeRange(loop.statement, sf),
          shortCircuitProne: false,
        })
        break
      }
      case ts.SyntaxKind.CatchClause: {
        const cc = node as TypeScript.CatchClause
        sites.push({ kind: "catch", ...nodeRange(cc.block, sf), shortCircuitProne: false })
        break
      }
      default:
        break
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return sites
}

// ────────────────────────────────────────────────────────────────────────────
// V8 byte-range containment — the per-branch counter algorithm (c8 pattern)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Find the smallest V8 range fully containing `[pos, end)`. Returns null
 * when no range contains the arm — that arm is reported as uncovered.
 *
 * Algorithm: linear scan, keep best (smallest width). Acceptable because the
 * range count per file is bounded by ~function count × ~3, typically <500.
 * If profiling proves a hotspot, swap for an interval tree (out of scope).
 */
const smallestEnclosingRange = (
  ranges: ReadonlyArray<V8Range>,
  pos: number,
  end: number,
): V8Range | null => {
  let best: V8Range | null = null
  let bestWidth = Number.POSITIVE_INFINITY
  for (const r of ranges) {
    if (r.startOffset <= pos && r.endOffset >= end) {
      const w = r.endOffset - r.startOffset
      if (w < bestWidth) {
        best = r
        bestWidth = w
      }
    }
  }
  return best
}

interface FileMetrics {
  readonly file: string
  readonly fc: FileCoverage
  readonly sites: ReadonlyArray<BranchSite>
  readonly hits: ReadonlyArray<number>
  readonly shortCircuitWarnings: number
  readonly lineStarts: ReadonlyArray<number>
}

// ────────────────────────────────────────────────────────────────────────────
// FileCoverage assembly with PER-BRANCH counters
// ────────────────────────────────────────────────────────────────────────────

const safePercent = (covered: number, total: number): number => {
  if (total === 0) return 100
  const p = (covered * 100) / total
  return Math.max(0, Math.min(100, Math.round(p * 100) / 100))
}

interface PerSiteAccount {
  readonly hits: number[]
  readonly branchesCovered: number
  readonly shortCircuitWarnings: number
}

/**
 * Walk the AST branch sites + V8 ranges to produce per-arm hit counts.
 * Strict mode adds a `shortCircuitWarnings` count whenever a short-circuit-
 * prone arm either lacks an enclosing range OR inherits its count from a
 * range >2x its own width (V8 didn't carve out the RHS).
 */
const accountPerSite = (
  sites: ReadonlyArray<BranchSite>,
  allRanges: ReadonlyArray<V8Range>,
  fidelity: "lenient" | "strict",
): PerSiteAccount => {
  const hits: number[] = []
  let branchesCovered = 0
  let shortCircuitWarnings = 0
  for (const site of sites) {
    const r = smallestEnclosingRange(allRanges, site.pos, site.end)
    if (r === null) {
      hits.push(0)
      if (fidelity === "strict" && site.shortCircuitProne) shortCircuitWarnings += 1
      continue
    }
    hits.push(r.count)
    if (r.count > 0) branchesCovered += 1
    if (
      fidelity === "strict" &&
      site.shortCircuitProne &&
      r.endOffset - r.startOffset > (site.end - site.pos) * 2
    ) {
      shortCircuitWarnings += 1
    }
  }
  return { hits, branchesCovered, shortCircuitWarnings }
}

const buildFileMetrics = async (
  script: V8Script,
  abs: string,
  compilerOptions: TypeScript.CompilerOptions | undefined,
  fidelity: "lenient" | "strict",
): Promise<FileMetrics | null> => {
  let source: string
  try {
    source = await readFile(abs, "utf8")
  } catch {
    return null
  }
  // Coverage is opt-in; importing/constructing this adapter must not initialize
  // the compiler during an unrelated runtime boot or readout request.
  const ts = await import("typescript")
  const parseOptions = compilerOptions ?? defaultCompilerOptions(ts)
  const allRanges: V8Range[] = []
  for (const fn of script.functions) {
    for (const r of fn.ranges) allRanges.push(r)
  }
  const { covered, uncoveredLines, lineCount } = computeLineCoverage(source, allRanges)
  const linesCovered = covered.size
  const lineStarts = computeLineStarts(source)

  const sf = ts.createSourceFile(
    abs,
    source,
    parseOptions.target ?? ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    scriptKindFromPath(abs, ts),
  )
  const sites = enumerateBranches(sf, ts)
  const { hits, branchesCovered, shortCircuitWarnings } = accountPerSite(sites, allRanges, fidelity)
  const branchCount = sites.length
  const statementCount = lineCount
  const statementsCovered = linesCovered
  const fc: FileCoverage = {
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
  return { file: abs, fc, sites, hits, shortCircuitWarnings, lineStarts }
}

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
// Per-branch hit map — exported helper for the Istanbul-shape emitter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sidecar with per-branch metadata + hit counts. The {@link CoverageReport}
 * port surface stays byte-compatible (the public adapter only widens what's
 * surfaced via getBranchSites + getBranchHits — opt-in calls).
 *
 * The map is keyed by absolute file path; if a caller used a NEW source
 * adapter instance, the map is empty until the next `read()`.
 */
export interface PerBranchSidecar {
  /** Per-file branch metadata in AST visit order. Same order as `getBranchHits`. */
  readonly sites: ReadonlyMap<string, ReadonlyArray<BranchSite>>
  /** Per-file hit counts in the same order as `sites`. */
  readonly hits: ReadonlyMap<string, ReadonlyArray<number>>
  /** Per-file count of low-fidelity short-circuit branches (strict mode only). */
  readonly shortCircuitWarnings: ReadonlyMap<string, number>
  /** Per-file byte-offset → line mapping (sorted ascending byte offsets where
   *  each 1-indexed line starts). Surfaced so the Istanbul-shape emitter can
   *  resolve precise line numbers without re-reading the source. */
  readonly lineStarts: ReadonlyMap<string, ReadonlyArray<number>>
}

/** Expose the per-branch sidecar for the Istanbul-shape emitter. The port
 *  itself (`CoverageSource`) stays byte-compatible; this is an opt-in cast. */
export interface IstanbulCoverageSourceExt extends CoverageSource {
  readonly lastSidecar: PerBranchSidecar
}

export type { BranchKind, BranchSite }

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

class IstanbulCoverageSource implements IstanbulCoverageSourceExt {
  private readonly compilerOptions: TypeScript.CompilerOptions | undefined
  private readonly skipPattern: RegExp
  private readonly fidelity: "lenient" | "strict"
  private _sidecar: PerBranchSidecar = {
    sites: new Map(),
    hits: new Map(),
    shortCircuitWarnings: new Map(),
    lineStarts: new Map(),
  }

  constructor(opts: IstanbulCoverageSourceOpts) {
    this.compilerOptions = opts.compilerOptions
    this.skipPattern = opts.skipPattern ?? DEFAULT_SKIP
    this.fidelity = opts.shortCircuitFidelity ?? "lenient"
  }

  get lastSidecar(): PerBranchSidecar {
    return this._sidecar
  }

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
    const sitesMap = new Map<string, ReadonlyArray<BranchSite>>()
    const hitsMap = new Map<string, ReadonlyArray<number>>()
    const warnMap = new Map<string, number>()
    const lineStartsMap = new Map<string, ReadonlyArray<number>>()
    for (const script of doc.result) {
      const abs = urlToAbsPath(script.url, this.skipPattern)
      if (abs === null) continue
      const fm = await buildFileMetrics(script, abs, this.compilerOptions, this.fidelity)
      if (fm === null) continue
      files.push(fm.fc)
      sitesMap.set(fm.file, fm.sites)
      hitsMap.set(fm.file, fm.hits)
      warnMap.set(fm.file, fm.shortCircuitWarnings)
      lineStartsMap.set(fm.file, fm.lineStarts)
    }
    this._sidecar = {
      sites: sitesMap,
      hits: hitsMap,
      shortCircuitWarnings: warnMap,
      lineStarts: lineStartsMap,
    }
    return {
      files,
      totals: computeTotals(files),
      generatedAt: Date.now(),
    }
  }
}
