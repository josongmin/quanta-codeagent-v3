/**
 * c8-backed coverage source adapter (ADR-0172, supersedes the internals of
 * ADR-0165 / ADR-0170).
 *
 * Sibling of `v8-source.ts` + `ast-source.ts`. Same {@link CoverageSource}
 * port; same `CoverageReport` shape. The READ path is delegated to
 * `c8` (https://github.com/bcoe/c8) — the canonical V8 + Istanbul reporter
 * wrapper maintained by the Node.js TSC.
 *
 * Pipeline contract (CALLER drives c8 — this adapter is JSON-in/report-out):
 *
 *   1. caller runs `bunx c8 --reporter=json bun test` (or any other runner)
 *   2. c8 writes `coverage/coverage-final.json` (Istanbul shape)
 *   3. caller hands the path to {@link c8CoverageSource}().read(path)
 *   4. adapter returns a typed {@link CoverageReport} — same shape v8/ast emit
 *
 * Istanbul JSON shape this adapter accepts (per-file map):
 *
 * ```json
 * {
 *   "/abs/path.ts": {
 *     "path": "/abs/path.ts",
 *     "statementMap": { "0": { "start": { "line": 1, "column": 0 },
 *                              "end":   { "line": 1, "column": 12 } } },
 *     "fnMap":        { "0": { "name": "...", "loc": {...}, "line": 1 } },
 *     "branchMap":    { "0": { "type": "if",
 *                              "loc": {...},
 *                              "locations": [ {start,end}, {start,end} ] } },
 *     "s": { "0": 5 },        // per-statement execution count
 *     "f": { "0": 5 },        // per-function execution count
 *     "b": { "0": [5, 0] }    // per-branch ARM execution counts
 *   }
 * }
 * ```
 *
 * SUBTLE: branchCount = sum over branchMap entries of `entry.locations.length`
 * (NOT the entry count). An `if/else` is ONE branchMap entry with TWO
 * locations → branchCount += 2, NOT 1. This is the precision win over
 * `v8-source.ts` (which keyword-counts both `if` and `else` as +1 each, but
 * cannot tell which arm was actually exercised). The richness is in `b`:
 * Istanbul tells us per-ARM execution counts, so `branchesCovered` is a true
 * count (NOT the linesCovered-ratio heuristic v8/ast use).
 *
 * Plane-clean: imports ONLY `node:fs/promises` + the in-slice port +
 * `errMessage` from `@/shared` (pure helper, no I/O — single-symbol
 * carve-out documented in ADR-0165 §Plane discipline; admits the canonical
 * `errMessage` policy so future R5-shape behaviour patches reach this slice
 * instead of drifting at inline ternaries).
 * No `c8` import — the adapter only consumes c8's JSON OUTPUT, so c8 stays
 * a devDependency the caller invokes out-of-process. This keeps the slice
 * dep-free for callers that hand-craft an Istanbul JSON (tests).
 *
 * Default-OFF: caller picks the source explicitly. The `coverage_check` tool
 * defaults to v8 source (ADR-0165) for backward compatibility; operators who
 * want strict per-branch counts pass `c8CoverageSource()` instead.
 */

import { readFile } from "node:fs/promises"
import { errMessage } from "@/shared"
import { CoverageError, type CoverageReport, type CoverageSource, type FileCoverage } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Istanbul JSON shape — typed surface for `JSON.parse` output
// ────────────────────────────────────────────────────────────────────────────

interface IstanbulPosition {
  readonly line: number
  readonly column: number
}

interface IstanbulLoc {
  readonly start: IstanbulPosition
  readonly end: IstanbulPosition
}

interface IstanbulStatement {
  readonly start: IstanbulPosition
  readonly end: IstanbulPosition
}

interface IstanbulBranch {
  /** `if` | `cond-expr` | `binary-expr` | `switch` | `default-arg` — opaque
   *  to us; we only use `.locations.length` for arm count. */
  readonly type?: string
  readonly loc?: IstanbulLoc
  readonly locations: ReadonlyArray<IstanbulLoc>
}

interface IstanbulFileCoverage {
  readonly path: string
  readonly statementMap: Readonly<Record<string, IstanbulStatement>>
  readonly fnMap?: Readonly<Record<string, unknown>>
  readonly branchMap: Readonly<Record<string, IstanbulBranch>>
  readonly s: Readonly<Record<string, number>>
  readonly f?: Readonly<Record<string, number>>
  readonly b: Readonly<Record<string, ReadonlyArray<number>>>
}

type IstanbulDoc = Readonly<Record<string, IstanbulFileCoverage>>

// ────────────────────────────────────────────────────────────────────────────
// Type guards — fail closed on any field drift (raises typed CoverageError)
// ────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const isStatement = (v: unknown): v is IstanbulStatement => {
  if (!isObj(v)) return false
  const start = v.start
  const end = v.end
  return isObj(start) && typeof start.line === "number" && isObj(end)
}

const isBranch = (v: unknown): v is IstanbulBranch => {
  if (!isObj(v)) return false
  const locs = v.locations
  return Array.isArray(locs)
}

const isNumberMap = (v: unknown): v is Record<string, number> => {
  if (!isObj(v)) return false
  for (const k of Object.keys(v)) {
    if (typeof v[k] !== "number") return false
  }
  return true
}

const isBranchHitMap = (v: unknown): v is Record<string, ReadonlyArray<number>> => {
  if (!isObj(v)) return false
  for (const k of Object.keys(v)) {
    const arr = v[k]
    if (!Array.isArray(arr)) return false
    for (const n of arr) {
      if (typeof n !== "number") return false
    }
  }
  return true
}

const isFileCoverage = (v: unknown): v is IstanbulFileCoverage => {
  if (!isObj(v)) return false
  if (typeof v.path !== "string") return false
  const sm = v.statementMap
  if (!isObj(sm)) return false
  for (const k of Object.keys(sm)) {
    if (!isStatement(sm[k])) return false
  }
  const bm = v.branchMap
  if (!isObj(bm)) return false
  for (const k of Object.keys(bm)) {
    if (!isBranch(bm[k])) return false
  }
  if (!isNumberMap(v.s)) return false
  if (!isBranchHitMap(v.b)) return false
  return true
}

const parseIstanbulDoc = (raw: unknown): IstanbulDoc | null => {
  if (!isObj(raw)) return null
  for (const key of Object.keys(raw)) {
    if (!isFileCoverage(raw[key])) return null
  }
  return raw as IstanbulDoc
}

// ────────────────────────────────────────────────────────────────────────────
// Numerics
// ────────────────────────────────────────────────────────────────────────────

const safePercent = (covered: number, total: number): number => {
  if (total === 0) return 100
  const p = (covered * 100) / total
  return Math.max(0, Math.min(100, Math.round(p * 100) / 100))
}

// ────────────────────────────────────────────────────────────────────────────
// Per-file projection — Istanbul → FileCoverage
// ────────────────────────────────────────────────────────────────────────────

interface StatementTally {
  readonly statementCount: number
  readonly statementsCovered: number
  readonly uncoveredLines: ReadonlyArray<number>
}

const tallyStatements = (ic: IstanbulFileCoverage): StatementTally => {
  const statementIds = Object.keys(ic.statementMap)
  let statementsCovered = 0
  const uncoveredLines = new Set<number>()
  for (const id of statementIds) {
    const hit = ic.s[id] ?? 0
    const stmt = ic.statementMap[id]
    if (hit > 0) {
      statementsCovered += 1
    } else if (stmt !== undefined) {
      uncoveredLines.add(stmt.start.line)
    }
  }
  return {
    statementCount: statementIds.length,
    statementsCovered,
    uncoveredLines: Array.from(uncoveredLines).sort((a, b) => a - b),
  }
}

interface LineTally {
  readonly lineCount: number
  readonly linesCovered: number
}

const tallyLines = (ic: IstanbulFileCoverage): LineTally => {
  // A line is covered if ANY statement starting on it has hit > 0.
  const allLines = new Set<number>()
  const coveredLines = new Set<number>()
  for (const id of Object.keys(ic.statementMap)) {
    const stmt = ic.statementMap[id]
    if (stmt === undefined) continue
    const ln = stmt.start.line
    allLines.add(ln)
    if ((ic.s[id] ?? 0) > 0) coveredLines.add(ln)
  }
  return { lineCount: allLines.size, linesCovered: coveredLines.size }
}

interface BranchTally {
  readonly branchCount: number
  readonly branchesCovered: number
}

const tallyBranches = (ic: IstanbulFileCoverage): BranchTally => {
  // SUM of arm counts across branchMap entries (NOT entry count). An
  // `if/else` is ONE branchMap entry with TWO locations → +2. This is the
  // Istanbul "per-arm" convention that v8-source/ast-source approximate.
  let branchCount = 0
  let branchesCovered = 0
  for (const id of Object.keys(ic.branchMap)) {
    const entry = ic.branchMap[id]
    if (entry === undefined) continue
    branchCount += entry.locations.length
    const hits = ic.b[id]
    if (hits === undefined) continue
    for (const h of hits) {
      if (h > 0) branchesCovered += 1
    }
  }
  return { branchCount, branchesCovered }
}

const buildFileCoverage = (ic: IstanbulFileCoverage): FileCoverage => {
  const s = tallyStatements(ic)
  const l = tallyLines(ic)
  const b = tallyBranches(ic)
  return {
    file: ic.path,
    lineCount: l.lineCount,
    linesCovered: l.linesCovered,
    linesPercent: safePercent(l.linesCovered, l.lineCount),
    branchCount: b.branchCount,
    branchesCovered: b.branchesCovered,
    branchesPercent: safePercent(b.branchesCovered, b.branchCount),
    statementCount: s.statementCount,
    statementsCovered: s.statementsCovered,
    statementsPercent: safePercent(s.statementsCovered, s.statementCount),
    uncoveredLines: s.uncoveredLines,
  }
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
// Options + adapter
// ────────────────────────────────────────────────────────────────────────────

export interface C8SourceOpts {
  /** Default `coverage-final.json` path used when `read()` is called with no
   *  argument. Matches c8's default output directory (`coverage/`). */
  readonly reportJsonPath?: string
}

const DEFAULT_REPORT_PATH = "coverage/coverage-final.json"

class C8CoverageSource implements CoverageSource {
  readonly #defaultPath: string

  constructor(opts: C8SourceOpts = {}) {
    this.#defaultPath = opts.reportJsonPath ?? DEFAULT_REPORT_PATH
  }

  /** Default-arg convention: pass an empty string to fall back to
   *  `opts.reportJsonPath` (or the `coverage/coverage-final.json` default).
   *  The port signature requires a string, so this preserves the contract
   *  while letting callers omit the path when c8 was run with defaults. */
  async read(coverageJsonPath: string): Promise<CoverageReport> {
    const path = coverageJsonPath.length === 0 ? this.#defaultPath : coverageJsonPath
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (e) {
      throw new CoverageError("io-failed", `c8 coverage: read failed: ${errMessage(e)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new CoverageError("json-malformed", `c8 coverage: invalid JSON: ${errMessage(e)}`)
    }
    const doc = parseIstanbulDoc(parsed)
    if (doc === null) {
      throw new CoverageError(
        "json-malformed",
        "c8 coverage: not a valid Istanbul coverage-final.json document",
      )
    }
    const files: FileCoverage[] = []
    for (const key of Object.keys(doc)) {
      const entry = doc[key]
      if (entry === undefined) continue
      if (entry.path.includes("node_modules")) continue
      files.push(buildFileCoverage(entry))
    }
    return {
      files,
      totals: computeTotals(files),
      generatedAt: Date.now(),
    }
  }
}

/** Construct a c8-backed coverage source. RECOMMENDED default for new
 *  callers — per-arm branch precision via Istanbul instrumentation. */
export const c8CoverageSource = (opts?: C8SourceOpts): CoverageSource =>
  new C8CoverageSource(opts ?? {})
