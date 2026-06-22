/**
 * God-code detector (SE-metric ratchet source).
 *
 * Two structural smells that biome's per-rule lint does NOT catch at the FILE
 * level:
 *   - GOD-MODULE: a source file far larger than a cohesive unit should be. Line
 *     count is a crude but robust, language-agnostic proxy; a 4000-line file is a
 *     god-module regardless of per-function complexity.
 *   - GOD-FUNCTION (length): a single function/method whose BODY spans more lines
 *     than anyone can hold in their head. (Cognitive COMPLEXITY is already gated
 *     by biome `noExcessiveCognitiveComplexity` maxAllowedComplexity=15; LENGTH is
 *     orthogonal — a long low-branching function is still a god-function.)
 *
 * Pure over injected `{ path, text }` records so the ratchet test stays
 * deterministic + fs-free. The thresholds are deliberately lenient (this is a
 * RATCHET: freeze the current violations, forbid NEW ones, require the allowlist
 * to shrink — never grow).
 */

import ts from "typescript"

export const GOD_MODULE_MAX_LINES = 1000
export const GOD_FUNCTION_MAX_LINES = 150

export interface SourceFile {
  readonly path: string
  readonly text: string
}

export interface GodModule {
  readonly file: string
  readonly lines: number
}

export interface GodFunction {
  /** Stable `file::name` key (line-shift independent — name, not line number). */
  readonly key: string
  readonly file: string
  readonly name: string
  readonly lines: number
}

const lineCount = (text: string): number => text.split("\n").length

/** Files whose total line count exceeds the god-module threshold. */
export const detectGodModules = (
  files: readonly SourceFile[],
  maxLines: number = GOD_MODULE_MAX_LINES,
): readonly GodModule[] =>
  files
    .map((f) => ({ file: f.path, lines: lineCount(f.text) }))
    .filter((m) => m.lines > maxLines)
    .sort((a, b) => b.lines - a.lines)

/** Best-effort name for a function-like node: its own identifier, or the
 *  variable / property / method it is assigned to (so `export const f = () =>`
 *  is named `f`). Falls back to `<anonymous@line>` only for truly unnameable
 *  inline callbacks (rare among god-sized functions). */
const functionName = (node: ts.Node, sf: ts.SourceFile): string => {
  const named = node as { name?: ts.Node }
  if (named.name !== undefined && ts.isIdentifier(named.name as ts.Node))
    return (named.name as ts.Identifier).text
  const p = node.parent
  if (p !== undefined && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name))
    return p.name.text
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  return `<anonymous@${line}>`
}

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node)

/**
 * Functions whose BODY spans more than the threshold, via the TypeScript AST
 * (accurate line spans; immune to string/comment braces). Keyed by `file::name`
 * so the ratchet survives line shifts. Nested function-likes are counted on their
 * own merit (a 200-line inline callback is still a god-function).
 */
export const detectGodFunctions = (
  files: readonly SourceFile[],
  maxLines: number = GOD_FUNCTION_MAX_LINES,
): readonly GodFunction[] => {
  const out: GodFunction[] = []
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && node.body !== undefined) {
        const start = sf.getLineAndCharacterOfPosition(node.body.getStart(sf)).line
        const end = sf.getLineAndCharacterOfPosition(node.body.getEnd()).line
        const span = end - start + 1
        if (span > maxLines) {
          const name = functionName(node, sf)
          out.push({ key: `${f.path}::${name}`, file: f.path, name, lines: span })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return out.sort((a, b) => b.lines - a.lines)
}
