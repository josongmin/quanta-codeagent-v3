/**
 * tools/shared/ts-exports.ts — THE answer to "what does this .ts file export".
 *
 * There used to be three of these. Two were regexes and one was the TypeScript
 * AST, they disagreed on 15 of 3,318 `src/**.ts` files, and in every sampled
 * case the AST was right. The regex readers shared one specific, measured
 * defect: they stripped `/* … *\/` BEFORE `//` line comments, so a LINE comment
 * containing `/*` (`resources/*`, `@/runner/assemble/*`) opened a fake block
 * comment that ran to the next `*\/`. In `src/tool/index.ts` that swallowed
 * 12,016 characters and deleted 237 export names; in `src/apps/cli/internal.ts`
 * it hid `export type { Tooling } from …` behind a 576-character phantom. They
 * also hallucinated exports out of regex LITERALS
 * (`/^export const resolveBenchRunConfig\b/` in
 * `src/apps/bench/promax/campaign/owner-audit.ts`) and could not see
 * `export function*` at all, because `function` was not followed by `\s`.
 *
 * A real parser has none of those failure modes, so there is now one reader and
 * `tests/unit/_arch/ts-exports-ssot.test.ts` keeps it that way.
 *
 * Dependency-light on purpose: `typescript` is already a devDependency and is
 * already imported by `tests/unit/_arch/slice-boundary-scanner.ts`. Nothing
 * here touches the filesystem or resolves modules — it is a pure function of
 * the source text, so every consumer can unit-test it without a repository.
 */

import ts from "typescript"

/** `export { srcName as exposed } from "spec"` — a name re-exposed from elsewhere. */
export interface ReexportBinding {
  /** The name importers of THIS module see. */
  readonly exposed: string
  /** The name as the target module exports it. */
  readonly srcName: string
  /** The module specifier, verbatim. */
  readonly spec: string
}

/**
 * The full export surface of one module, split the way the reachability graph
 * needs it. The own/re-export distinction is load-bearing for its consumers:
 * `ownExports` are names this file DECLARES, `reexports` are names it merely
 * forwards and whose real definition lives at `spec`.
 */
export interface ModuleExports {
  /** Names declared (or locally bound) and exported here, plus `default`. */
  readonly ownExports: ReadonlySet<string>
  /** `export { a as b } from "spec"` / `export type { T } from "spec"`. */
  readonly reexports: readonly ReexportBinding[]
  /** `export * from "spec"` — contributes no NAME, only an edge. */
  readonly starSpecs: readonly string[]
  /**
   * Specifiers of `export * as ns from "spec"`. The namespace NAME is in
   * `ownExports`; the spec is here because the whole target module is used.
   */
  readonly namespaceReexportSpecs: readonly string[]
}

const collectBindingNames = (name: ts.BindingName, out: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    out.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out)
  }
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)

const isExported = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword)

const isDefaultExported = (node: ts.Node): boolean =>
  hasModifier(node, ts.SyntaxKind.DefaultKeyword)

const NAMED_DECLARATION_GUARDS = [
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isModuleDeclaration,
] as const

/** Accumulator mirroring {@link ModuleExports} while the walk is in progress. */
interface Acc {
  readonly ownExports: Set<string>
  readonly reexports: ReexportBinding[]
  readonly starSpecs: string[]
  readonly namespaceReexportSpecs: string[]
}

const specifierText = (statement: ts.ExportDeclaration): string | undefined => {
  const spec = statement.moduleSpecifier
  return spec !== undefined && ts.isStringLiteral(spec) ? spec.text : undefined
}

/** `export { … }`, `export { … } from "…"`, `export * [as ns] from "…"`. */
const collectFromExportDeclaration = (statement: ts.ExportDeclaration, acc: Acc): void => {
  const spec = specifierText(statement)
  const clause = statement.exportClause

  if (clause === undefined) {
    // `export * from "spec"` — an edge with no name attached.
    if (spec !== undefined) acc.starSpecs.push(spec)
    return
  }

  if (ts.isNamespaceExport(clause)) {
    // `export * as ns from "spec"` — the NAME is ours, the whole target is used.
    acc.ownExports.add(clause.name.text)
    if (spec !== undefined) acc.namespaceReexportSpecs.push(spec)
    return
  }

  for (const element of clause.elements) {
    const exposed = element.name.text
    if (spec === undefined) {
      // `export { local }` / `export { local as exposed }` — defined in THIS file.
      acc.ownExports.add(exposed)
      continue
    }
    acc.reexports.push({ exposed, srcName: (element.propertyName ?? element.name).text, spec })
  }
}

/**
 * `export function f`, `export class C`, `export type T`, …
 *
 * A DEFAULT-exported declaration contributes `default` and NOT its local name:
 * `export default function m() {}` and `export default m` expose the very same
 * thing to importers, so recording `m` for one and `default` for the other made
 * a pure refactor between the two forms read as a deleted symbol.
 */
const collectFromNamedDeclaration = (statement: ts.Statement, acc: Acc): void => {
  if (!NAMED_DECLARATION_GUARDS.some((is) => is(statement))) return
  if (isDefaultExported(statement)) {
    acc.ownExports.add("default")
    return
  }
  const name = (statement as ts.DeclarationStatement).name
  if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
    acc.ownExports.add(name.text)
  }
}

const collectFromStatement = (statement: ts.Statement, acc: Acc): void => {
  // `export default <expr>` and `export = <expr>`.
  if (ts.isExportAssignment(statement)) {
    acc.ownExports.add("default")
    return
  }
  if (ts.isExportDeclaration(statement)) {
    collectFromExportDeclaration(statement, acc)
    return
  }
  if (!isExported(statement)) return
  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) {
      collectBindingNames(decl.name, acc.ownExports)
    }
    return
  }
  collectFromNamedDeclaration(statement, acc)
}

/**
 * Parse a module's export surface. `fileName` is only used for diagnostics and
 * to pick the script kind; it never hits the filesystem.
 */
export const parseModuleExports = (source: string, fileName = "input.ts"): ModuleExports => {
  const acc: Acc = {
    ownExports: new Set<string>(),
    reexports: [],
    starSpecs: [],
    namespaceReexportSpecs: [],
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  for (const statement of sourceFile.statements) collectFromStatement(statement, acc)
  return acc
}

/**
 * Every NAME this module exposes — own declarations plus forwarded names. The
 * flat view, for consumers that only compare presence/absence of a name.
 *
 * `export * from "…"` contributes nothing (it has no name to compare), so a
 * barrel that swaps a star re-export is invisible here. That is a known and
 * accepted blind spot of the name-level signal.
 */
export const extractExportedSymbols = (source: string, fileName = "input.ts"): Set<string> => {
  const parsed = parseModuleExports(source, fileName)
  const out = new Set<string>(parsed.ownExports)
  for (const rx of parsed.reexports) out.add(rx.exposed)
  return out
}
