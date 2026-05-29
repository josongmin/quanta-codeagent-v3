/**
 * Istanbul-shape JSON emitter (ADR-0173 — Phase 3 of ADR-0165/0170).
 *
 * Convert a typed {@link CoverageReport} into the canonical Istanbul JSON
 * shape coveralls / codecov / SonarQube ingest:
 *
 * ```json
 * { "/abs/path.ts": {
 *     "path": "/abs/path.ts",
 *     "statementMap": { "0": { "start": {"line":1,"column":0},
 *                              "end":   {"line":1,"column":80} }, ... },
 *     "s":            { "0": 1, "1": 0, ... },
 *     "fnMap":        { "0": { "name":"f", "line":1, "loc":..., "decl":... }, ... },
 *     "f":            { "0": 3, "1": 0, ... },
 *     "branchMap":    { "0": { "type":"if", "line":2, "loc":...,
 *                              "locations":[arm0Loc, arm1Loc] }, ... },
 *     "b":            { "0": [3, 0], ... }
 *   }
 * }
 * ```
 *
 * Plane-clean: this module imports ONLY the in-slice port + the in-slice
 * sidecar (BranchSite). NO `node:fs`, NO `typescript` (the source adapter
 * already did the AST work). The emitter is purely shape-transformation —
 * the caller writes the result to disk if they want a file.
 *
 * Statement / function maps:
 *   - The current `FileCoverage` port surfaces LINE coverage, not statement
 *     ID coverage. We synthesize one `statementMap` entry per LINE (the
 *     v8-source.ts heuristic treats `statementCount === lineCount` — we
 *     mirror that here). `s[idx]` is 0/1 per line.
 *   - The port does not currently surface FUNCTION coverage. `fnMap` and `f`
 *     are emitted as EMPTY objects (Istanbul tolerates this; codecov reads
 *     statement+branch only). A future ADR can wire function metadata in.
 *
 * Branch IDs (stability policy — see ADR-0173 §branchId-stability):
 *   - `branchId = index-in-AST-visit-order` per file. Stable across re-runs
 *     of the SAME source (the TS visitor is deterministic).
 *   - When source EDITS shift AST positions, branchId SHIFTS by the visit-
 *     order change. The merge step (`./merge.ts`) detects this drift and
 *     throws; callers MUST re-generate the Istanbul JSON after each source
 *     change before merging.
 */

import type { BranchKind, BranchSite, PerBranchSidecar } from "./istanbul-source"
import type { CoverageReport, FileCoverage } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Istanbul JSON shape — typed for our emitter's output. We DO NOT validate
// downstream Istanbul tooling shape strictness — the canonical schema (from
// `istanbul-lib-coverage`) is loose by design.
// ────────────────────────────────────────────────────────────────────────────

export interface IstanbulPosition {
  readonly line: number
  readonly column: number
}

export interface IstanbulRange {
  readonly start: IstanbulPosition
  readonly end: IstanbulPosition
}

export interface IstanbulBranchEntry {
  readonly type: "if" | "binary-expr" | "cond-expr" | "switch" | "default-arg"
  readonly line: number
  readonly loc: IstanbulRange
  readonly locations: ReadonlyArray<IstanbulRange>
}

export interface IstanbulFnEntry {
  readonly name: string
  readonly line: number
  readonly loc: IstanbulRange
  readonly decl: IstanbulRange
}

export interface IstanbulFileEntry {
  readonly path: string
  readonly statementMap: Readonly<Record<string, IstanbulRange>>
  readonly s: Readonly<Record<string, number>>
  readonly fnMap: Readonly<Record<string, IstanbulFnEntry>>
  readonly f: Readonly<Record<string, number>>
  readonly branchMap: Readonly<Record<string, IstanbulBranchEntry>>
  readonly b: Readonly<Record<string, ReadonlyArray<number>>>
}

export type IstanbulCoverageJson = Readonly<Record<string, IstanbulFileEntry>>

// ────────────────────────────────────────────────────────────────────────────
// Branch-kind → Istanbul type mapping
// ────────────────────────────────────────────────────────────────────────────

const branchKindToIstanbulType = (k: BranchKind): IstanbulBranchEntry["type"] => {
  switch (k) {
    case "if-then":
    case "if-else":
      return "if"
    case "switch-case":
      return "switch"
    case "cond-true":
    case "cond-false":
      return "cond-expr"
    case "binary-rhs":
      return "binary-expr"
    case "loop-body":
    case "catch":
      // Istanbul has no dedicated "loop" type — falls back to "if" semantics
      // (a 1-arm gate). Our `locations` array carries the precise span; the
      // type is just a UI hint.
      return "if"
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Position math — line/column from byte offset
//
// We do NOT receive the source string here (the source adapter did the parse),
// so column resolution is APPROXIMATE — we can derive line cheaply from
// `uncoveredLines` and the file's line count, but precise column requires the
// source. The port surface doesn't carry the offset→{line, column} table.
//
// Decision: emit `column: 0` for every position. Istanbul consumers tolerate
// line-only mapping (coveralls/codecov DON'T use column for sums; the line is
// the dedup key). The follow-up to wire precise columns is documented in
// ADR-0173 §Follow-up "source-map back-resolution".
// ────────────────────────────────────────────────────────────────────────────

const pos = (line: number): IstanbulPosition => ({ line, column: 0 })

const range = (startLine: number, endLine: number): IstanbulRange => ({
  start: pos(startLine),
  end: pos(endLine),
})

// ────────────────────────────────────────────────────────────────────────────
// Per-file builders
// ────────────────────────────────────────────────────────────────────────────

const buildStatementMaps = (
  fc: FileCoverage,
): { statementMap: Record<string, IstanbulRange>; s: Record<string, number> } => {
  const statementMap: Record<string, IstanbulRange> = {}
  const s: Record<string, number> = {}
  const uncovered = new Set(fc.uncoveredLines)
  // 1-indexed line → entry idx (0-indexed string keys, matching Istanbul).
  for (let ln = 1; ln <= fc.lineCount; ln += 1) {
    const idx = String(ln - 1)
    statementMap[idx] = range(ln, ln)
    s[idx] = uncovered.has(ln) ? 0 : 1
  }
  return { statementMap, s }
}

/** Group BranchSites that come from the SAME construct so Istanbul's
 *  `locations[]` array holds all arms of a single `if` / ternary / switch.
 *
 *  Grouping rule:
 *   - `if-then` + immediately-following `if-else` (consecutive in AST order
 *     AND same parent statement) → 1 group with locations = [then, else].
 *   - `cond-true` + immediately-following `cond-false` → 1 group.
 *   - All other arms → 1 group of length 1.
 *
 *  This MIRRORS nyc's accounting (each arm of an `if` is 1 branch BUT they
 *  cluster under one `branchMap` entry whose `locations` array carries both).
 */
/** Two-arm sister kinds — the only consecutive pairs that get grouped into
 *  ONE `branchMap` entry with `locations.length === 2`. */
const PAIR_FIRST: ReadonlySet<BranchSite["kind"]> = new Set(["if-then", "cond-true"])
const sisterKind = (k: BranchSite["kind"]): BranchSite["kind"] | null => {
  if (k === "if-then") return "if-else"
  if (k === "cond-true") return "cond-false"
  return null
}

const tryPair = (
  sites: ReadonlyArray<BranchSite>,
  hits: ReadonlyArray<number>,
  i: number,
): { sites: BranchSite[]; hits: number[]; advance: number } | null => {
  const cur = sites[i]
  if (cur === undefined || !PAIR_FIRST.has(cur.kind)) return null
  const expected = sisterKind(cur.kind)
  const next = sites[i + 1]
  if (next === undefined || expected === null || next.kind !== expected) return null
  return {
    sites: [cur, next],
    hits: [hits[i] ?? 0, hits[i + 1] ?? 0],
    advance: 2,
  }
}

const groupBranches = (
  sites: ReadonlyArray<BranchSite>,
  hits: ReadonlyArray<number>,
): Array<{ sites: BranchSite[]; hits: number[] }> => {
  const groups: Array<{ sites: BranchSite[]; hits: number[] }> = []
  let i = 0
  while (i < sites.length) {
    const paired = tryPair(sites, hits, i)
    if (paired !== null) {
      groups.push({ sites: paired.sites, hits: paired.hits })
      i += paired.advance
      continue
    }
    const cur = sites[i]
    if (cur === undefined) {
      i += 1
      continue
    }
    groups.push({ sites: [cur], hits: [hits[i] ?? 0] })
    i += 1
  }
  return groups
}

const buildBranchMaps = (
  sites: ReadonlyArray<BranchSite>,
  hits: ReadonlyArray<number>,
  lineStartsForOffset: (off: number) => number,
): {
  branchMap: Record<string, IstanbulBranchEntry>
  b: Record<string, ReadonlyArray<number>>
} => {
  const branchMap: Record<string, IstanbulBranchEntry> = {}
  const b: Record<string, ReadonlyArray<number>> = {}
  const groups = groupBranches(sites, hits)
  for (let gi = 0; gi < groups.length; gi += 1) {
    const g = groups[gi]
    if (g === undefined) continue
    const idx = String(gi)
    const locations: IstanbulRange[] = []
    const armHits: number[] = []
    for (let ai = 0; ai < g.sites.length; ai += 1) {
      const site = g.sites[ai]
      const hit = g.hits[ai]
      if (site === undefined) continue
      const startLine = lineStartsForOffset(site.pos)
      const endLine = lineStartsForOffset(Math.max(site.pos, site.end - 1))
      locations.push(range(startLine, endLine))
      armHits.push(hit ?? 0)
    }
    const first = g.sites[0]
    if (first === undefined) continue
    const headLine = lineStartsForOffset(first.pos)
    branchMap[idx] = {
      type: branchKindToIstanbulType(first.kind),
      line: headLine,
      loc: locations[0] ?? range(headLine, headLine),
      locations,
    }
    b[idx] = armHits
  }
  return { branchMap, b }
}

// ────────────────────────────────────────────────────────────────────────────
// Public emitter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a coverage report (typically the output of
 * `istanbulCoverageSource().read(...)`) into the Istanbul JSON shape.
 *
 * The optional sidecar carries the per-branch BranchSite list + per-arm hits
 * produced by `istanbulCoverageSource`. When omitted (e.g. caller used
 * `v8-source.ts` or `ast-source.ts`), the emitter produces statement-only
 * coverage — `branchMap` and `b` are empty objects.
 */
/** Binary search byte offset → 1-indexed line. Pure inverse of
 *  `computeLineStarts` (mirrors the math `v8-source.ts` uses internally; we
 *  duplicate the helper here to keep the emitter import-clean — no reach into
 *  the source adapter's privates). */
const lineFromOffsetFactory =
  (lineStarts: ReadonlyArray<number>) =>
  (off: number): number => {
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

const branchMapsFromSidecar = (
  file: string,
  sidecar: PerBranchSidecar,
): {
  branchMap: Record<string, IstanbulBranchEntry>
  b: Record<string, ReadonlyArray<number>>
} => {
  const sites = sidecar.sites.get(file)
  const hits = sidecar.hits.get(file)
  const lineStarts = sidecar.lineStarts.get(file)
  if (sites === undefined || hits === undefined || lineStarts === undefined) {
    return { branchMap: {}, b: {} }
  }
  return buildBranchMaps(sites, hits, lineFromOffsetFactory(lineStarts))
}

export const toIstanbulJson = (
  report: CoverageReport,
  sidecar?: PerBranchSidecar,
): IstanbulCoverageJson => {
  const out: Record<string, IstanbulFileEntry> = {}
  for (const fc of report.files) {
    const { statementMap, s } = buildStatementMaps(fc)
    // Empty fnMap / f (the port doesn't surface function coverage today).
    const fnMap: Record<string, IstanbulFnEntry> = {}
    const f: Record<string, number> = {}
    const { branchMap, b } =
      sidecar !== undefined ? branchMapsFromSidecar(fc.file, sidecar) : { branchMap: {}, b: {} }
    out[fc.file] = {
      path: fc.file,
      statementMap,
      s,
      fnMap,
      f,
      branchMap,
      b,
    }
  }
  return out
}
