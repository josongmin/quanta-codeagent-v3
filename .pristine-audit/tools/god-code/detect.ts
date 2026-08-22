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

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  // Accessors were a DETECTION HOLE: a 200-line `get foo()` / `set foo()` slid
  // past the ratchet entirely. They carry a body + name like a method, so a
  // god-sized accessor is a god-function.
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

/** The DIRECT name of a function-like: its own identifier (fn/method/accessor),
 *  or the variable / property it is bound to (so `export const f = () =>` is
 *  `f`). `undefined` for a truly anonymous inline callback (`new Promise(cb)`,
 *  `arr.map(cb)`). */
const directName = (node: ts.Node): string | undefined => {
  const named = node as { name?: ts.Node }
  if (named.name !== undefined && ts.isIdentifier(named.name as ts.Node))
    return (named.name as ts.Identifier).text
  const p = node.parent
  if (
    p !== undefined &&
    (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) &&
    ts.isIdentifier(p.name)
  )
    return p.name.text
  return undefined
}

/** The nearest ENCLOSING named scope — a named fn/method/accessor, or an
 *  arrow/fn-expr bound to a const/property; `<module>` at top level. Anonymous
 *  ancestors are skipped. */
const enclosingScopeName = (node: ts.Node): string => {
  let a = node.parent
  while (a !== undefined) {
    if (isFunctionLike(a)) {
      const dn = directName(a)
      if (dn !== undefined) return dn
    }
    a = a.parent
  }
  return "<module>"
}

/**
 * Functions whose BODY spans more than the threshold, via the TypeScript AST
 * (accurate line spans; immune to string/comment braces). Keyed by `file::name`
 * so the ratchet survives line shifts. Nested function-likes are counted on their
 * own merit (a 200-line inline callback is still a god-function).
 *
 * A truly anonymous callback is keyed `<scope>~anon<ordinal>` — its ordinal among
 * the anonymous callbacks that share the same enclosing named scope, in source
 * order. This is LINE-SHIFT-INDEPENDENT (unlike the old `<anonymous@line>`): code
 * added ABOVE an allowlisted anon god-fn no longer breaks its key nor silently
 * re-binds the grandfather to a different callback that drifted onto that line.
 */
export const detectGodFunctions = (
  files: readonly SourceFile[],
  maxLines: number = GOD_FUNCTION_MAX_LINES,
): readonly GodFunction[] => {
  const out: GodFunction[] = []
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true)
    // Collect every body-bearing function-like in source (pre-)order.
    const nodes: ts.FunctionLikeDeclaration[] = []
    const collect = (node: ts.Node): void => {
      if (isFunctionLike(node) && node.body !== undefined) nodes.push(node)
      ts.forEachChild(node, collect)
    }
    collect(sf)
    // Name EVERY node (in order) so anon ordinals are assigned deterministically
    // over ALL anons in a scope — not just the god-sized ones (which would drift).
    const anonSeq = new Map<string, number>()
    const nameOf = (node: ts.FunctionLikeDeclaration): string => {
      const direct = directName(node)
      if (direct !== undefined) return direct
      const scope = enclosingScopeName(node)
      const idx = anonSeq.get(scope) ?? 0
      anonSeq.set(scope, idx + 1)
      return `${scope}~anon${idx}`
    }
    for (const node of nodes) {
      const name = nameOf(node)
      const body = node.body as ts.Node
      const start = sf.getLineAndCharacterOfPosition(body.getStart(sf)).line
      const end = sf.getLineAndCharacterOfPosition(body.getEnd()).line
      const span = end - start + 1
      if (span > maxLines) out.push({ key: `${f.path}::${name}`, file: f.path, name, lines: span })
    }
  }
  return out.sort((a, b) => b.lines - a.lines)
}
