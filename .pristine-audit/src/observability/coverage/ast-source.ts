/**
 * AST-precise coverage source adapter (ADR-0167).
 *
 * Sibling of `v8-source.ts` (ADR-0165 §branch-heuristic). Same {@link
 * CoverageSource} port; same V8 line/statement signal. The branch count
 * comes from the TypeScript compiler API walk instead of the keyword-token
 * heuristic — no false positives in template literals / regex / strings.
 *
 * What the AST walk counts (matches `nyc`/Istanbul arm-style accounting —
 * each ARM of a multi-arm construct is one branch):
 *
 *   - `IfStatement.thenStatement`              → +1
 *   - `IfStatement.elseStatement` (if present) → +1 (recursive — an else-if
 *      is itself an IfStatement nested in the else slot, so an `else if` adds
 *      its own +1 for the else slot plus the inner +1/+1 for its then/else)
 *   - `SwitchStatement.caseBlock.clauses[]`    → +1 per CaseClause/DefaultClause
 *   - `ConditionalExpression` (ternary a?b:c)  → +2 (true arm + false arm)
 *   - `BinaryExpression` with op `&&` / `||` / `??` → +1 each (short-circuit)
 *   - `ForStatement` / `ForInStatement` / `ForOfStatement` / `WhileStatement`
 *     / `DoStatement`                          → +1 (loop body executes / not)
 *   - `CatchClause`                            → +1
 *
 * What the visitor SKIPS (recursion halts; the node's children are not
 * walked, so a branch keyword inside a string/template/regex is invisible):
 *
 *   - `StringLiteral`
 *   - `NoSubstitutionTemplateLiteral`
 *   - `RegularExpressionLiteral`
 *
 * Template literal `${}` POLICY (documented decision; see ADR-0167 §template):
 *   We DO walk into `TemplateExpression` children — the expression head/tail
 *   strings are not visited (they have no AST children), but each
 *   `TemplateSpan.expression` IS a real executable JS expression whose
 *   short-circuit ops / ternaries / etc. DO run at runtime and SHOULD count.
 *   Concretely: ``` `hello ${a && b} world` ``` counts +1 (the `&&`).
 *   `tagged` `${a}` `` works the same way — the expression inside `${}` is
 *   walked, the literal parts are not.
 *
 * Comments are stripped by the compiler before AST handing — `ts.forEachChild`
 * never visits a comment trivium, so `// if (x) { ... }` contributes 0.
 *
 * Plane-clean: imports ONLY `node:fs/promises` + `node:path` + `typescript`
 * + `errMessage` from `@/shared` (pure helper, no I/O — single-symbol
 * carve-out documented in ADR-0165 §Plane discipline; admits the canonical
 * `errMessage` policy so future R5-shape behaviour patches reach this slice
 * instead of drifting at inline ternaries)
 * + the in-slice port. No `@/agent`, `@/tool`, `@/llm`. The `MetricSink`
 * integration lives in `./reporter.ts` — this adapter purely transforms
 * bytes → typed report.
 *
 * branchesCovered estimation: SAME line-coverage-ratio heuristic the
 * v8-source uses. The AST gives an ACCURATE branchCount denominator but
 * has no per-branch execution counter — true per-branch coverage requires
 * Istanbul-style source instrumentation (out of scope, Phase 3 follow-up).
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import * as ts from "typescript"
import { errMessage } from "@/shared"
import { CoverageError, type CoverageReport, type CoverageSource, type FileCoverage } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export interface AstCoverageSourceOpts {
  /** Optional ts.CompilerOptions override. Defaults to a permissive setup
   *  matching the project's tsconfig.json — we only need a syntactic parse,
   *  not type-checking, so the options barely matter; allow callers to pin
   *  a specific `ScriptTarget` if they want to lock the AST against future
   *  syntax (e.g. parsing a known-ES2020 file even when the host is newer). */
  readonly compilerOptions?: ts.CompilerOptions
  /** Skip pattern for files. Default: `/node_modules\/|\.d\.ts$/`. The V8
   *  adapter already strips `node_modules` URLs; this is a secondary guard
   *  for callers that point us at a curated subset already containing some
   *  vendored sources, and to skip `.d.ts` declaration files (they have no
   *  runtime branches by construction). */
  readonly skipPattern?: RegExp
}

/** Construct the default AST-precise coverage source. */
export const astCoverageSource = (opts: AstCoverageSourceOpts = {}): CoverageSource =>
  new AstCoverageSource(opts)

// ────────────────────────────────────────────────────────────────────────────
// V8 JSON shape — typed surface for `JSON.parse` output
// (Duplicated from v8-source.ts on purpose — the constraint forbids modifying
// that file, and importing its private internals would leak shape across two
// public adapters. The V8 schema is small + stable; duplication is cheap.)
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
// URL / path filtering
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
// Byte-offset → line mapping (identical math to v8-source.ts; see ADR-0165)
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
// AST branch counter — the value-add of this adapter
// ────────────────────────────────────────────────────────────────────────────

/** Default compiler options for the syntactic parse. We do NOT type-check
 *  (no `getProgram`); `createSourceFile` is enough. We pick `Latest` so newer
 *  syntax (`??=`, decorators, etc.) does not error out the parse. */
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  // We do NOT set `strict` etc. — they only matter for type-check, which we
  // do not run. A misconfigured options object cannot mis-count branches.
}

/** Pick the right `ts.ScriptKind` from the path extension. Defaults to TS
 *  (we never see a `.d.ts` here — the skip pattern filtered it). */
const scriptKindFromPath = (abs: string): ts.ScriptKind => {
  if (abs.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (abs.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (abs.endsWith(".js") || abs.endsWith(".mjs") || abs.endsWith(".cjs")) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

/** Walk the AST and count branches per the rules in the module docstring.
 *
 *  Recursion bound: `ts.forEachChild` only visits AST CHILDREN (no leaves
 *  outside the tree, no shared-node revisit). The visitor returns `undefined`
 *  always so `forEachChild` never short-circuits before exhausting the file.
 *  Recursion depth is bounded by the file's parse-tree depth (TS files
 *  typically <50 deep; the JS engine's stack handles thousands). */
const countBranchesAst = (sf: ts.SourceFile): number => {
  let count = 0

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: AST visitor with closed switch over branch-bearing node kinds — splitting per-kind helpers would obscure the single-pass invariant
  const visit = (node: ts.Node): void => {
    // ── Recursion HALT cases — string/template/regex nodes have no
    //    executable branch children. We do NOT call forEachChild on them.
    if (
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      return
    }

    // ── TemplateExpression: we DO recurse but only into the spans'
    //    .expression — the head/middle/tail literal parts have no AST
    //    children to revisit. Forwarding the entire node to forEachChild
    //    handles this naturally (TS only emits visit-children for the
    //    expression slots; the literal parts are leaves).

    switch (node.kind) {
      case ts.SyntaxKind.IfStatement: {
        const ifs = node as ts.IfStatement
        // Then arm always exists.
        count += 1
        if (ifs.elseStatement !== undefined) {
          // Else arm — note: `else if` is itself an IfStatement nested in
          // the else slot. We add +1 for THIS else (the "we took the else
          // path" arm), and recursion will visit the nested IfStatement
          // separately and add its own then/else counts.
          count += 1
        }
        break
      }
      case ts.SyntaxKind.ConditionalExpression: {
        // a ? b : c → +2 (true arm + false arm)
        count += 2
        break
      }
      case ts.SyntaxKind.SwitchStatement: {
        const sw = node as ts.SwitchStatement
        for (const clause of sw.caseBlock.clauses) {
          // CaseClause OR DefaultClause — each is a +1 arm.
          if (
            clause.kind === ts.SyntaxKind.CaseClause ||
            clause.kind === ts.SyntaxKind.DefaultClause
          ) {
            count += 1
          }
        }
        break
      }
      case ts.SyntaxKind.BinaryExpression: {
        const be = node as ts.BinaryExpression
        const op = be.operatorToken.kind
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          count += 1
        }
        break
      }
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement: {
        // Loop body executes / does-not-execute → 1 branch (the body arm).
        // The condition's own short-circuits are caught by BinaryExpression.
        count += 1
        break
      }
      case ts.SyntaxKind.CatchClause: {
        // try {} catch {} → catch arm is a +1 (the "an error was thrown"
        // path). The try body itself is not a branch.
        count += 1
        break
      }
      default:
        // No-op — every other node type passes through to children.
        break
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return count
}

// ────────────────────────────────────────────────────────────────────────────
// FileCoverage assembly
// ────────────────────────────────────────────────────────────────────────────

const safePercent = (covered: number, total: number): number => {
  if (total === 0) return 100
  const p = (covered * 100) / total
  return Math.max(0, Math.min(100, Math.round(p * 100) / 100))
}

const branchesCoveredHeuristic = (
  branchCount: number,
  linesCovered: number,
  lineCount: number,
): number => {
  if (branchCount === 0) return 0
  if (lineCount === 0) return branchCount
  const ratio = linesCovered / lineCount
  return Math.round(branchCount * ratio)
}

const buildFileCoverage = async (
  script: V8Script,
  abs: string,
  compilerOptions: ts.CompilerOptions,
): Promise<FileCoverage | null> => {
  let source: string
  try {
    source = await readFile(abs, "utf8")
  } catch {
    // Source file disappeared between test-run and coverage-read; skip
    // silently — best-effort per-file (mirror of v8-source.ts behaviour).
    return null
  }
  const allRanges: V8Range[] = []
  for (const fn of script.functions) {
    for (const r of fn.ranges) allRanges.push(r)
  }
  const { covered, uncoveredLines, lineCount } = computeLineCoverage(source, allRanges)
  const linesCovered = covered.size

  // AST parse + branch count. `setParentNodes=false` keeps the parse cheap
  // (we don't traverse upward). `ScriptKind` is derived from the extension.
  const sf = ts.createSourceFile(
    abs,
    source,
    compilerOptions.target ?? ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    scriptKindFromPath(abs),
  )
  const branchCount = countBranchesAst(sf)
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
// Adapter
// ────────────────────────────────────────────────────────────────────────────

class AstCoverageSource implements CoverageSource {
  private readonly compilerOptions: ts.CompilerOptions
  private readonly skipPattern: RegExp

  constructor(opts: AstCoverageSourceOpts) {
    this.compilerOptions = opts.compilerOptions ?? DEFAULT_COMPILER_OPTIONS
    this.skipPattern = opts.skipPattern ?? DEFAULT_SKIP
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
    for (const script of doc.result) {
      const abs = urlToAbsPath(script.url, this.skipPattern)
      if (abs === null) continue
      const fc = await buildFileCoverage(script, abs, this.compilerOptions)
      if (fc !== null) files.push(fc)
    }
    return {
      files,
      totals: computeTotals(files),
      generatedAt: Date.now(),
    }
  }
}
