/**
 * `tools/dev/nested-suite-targets` — which test files spawn `bun test` on
 * ANOTHER file that the tier already runs.
 *
 * # The defect
 *
 * `tests/unit/bench-results-fence-hellgate.test.ts` used a child `bun test` to
 * prove the bench-results fence behaviourally — correct, and the only honest way
 * to observe a preload. But the child's target was
 * `tests/unit/bench-write-artifacts.test.ts`: an entire five-case sibling suite,
 * run TWICE (once against a hostile directory, once against an accepted one),
 * and that suite is in ordinary membership as well. A cold full run therefore
 * executed those five cases three times, and four of the five assert nothing
 * about the fence.
 *
 * The cost is invisible at the call site. `["bun", "test", victim]` looks like a
 * single operation; what it actually schedules is however many cases the target
 * happens to contain today, which grows as somebody else adds to it.
 *
 * # What is and is not a finding
 *
 * A child `bun test` is fine — sometimes it is the only instrument. What is not
 * fine is pointing it at a file the tier ALREADY runs, because then the work is
 * duplicated rather than added. So the rule is about the TARGET:
 *
 *   · a target that resolves to a repo `*.test.ts` → finding (unless allowlisted
 *     with a reason);
 *   · a target generated into a temp directory → not a finding, nothing else
 *     runs it;
 *   · a target the analyzer cannot resolve to a literal → not a finding, because
 *     inventing one would make the rule noise.
 *
 * # Why a parse
 *
 * The target is usually a variable (`const victim = "tests/unit/…"`), so the
 * string and the spawn are on different lines and a grep for `bun", "test` sees
 * only the spawn. The analyzer resolves one hop of local `const` binding, which
 * is the shape the corpus actually uses.
 */

import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import ts from "typescript"

export interface NestedSuiteTarget {
  readonly file: string
  readonly line: number
  /** Repo-relative path of the spawned target. */
  readonly target: string
}

export interface NestedSuiteInput {
  readonly path: string
  readonly text: string
  /** Absolute repo root, used to decide whether a target is a repo test file. */
  readonly repoRoot: string
}

const SPAWNERS: ReadonlySet<string> = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "$",
])

const rightmost = (expr: ts.Expression): string | undefined =>
  ts.isIdentifier(expr)
    ? expr.text
    : ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : undefined

/** String value of a node, following ONE hop of local `const x = "…"`. */
const literalOf = (
  node: ts.Expression,
  consts: ReadonlyMap<string, string>,
): string | undefined => {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return consts.get(node.text)
  return undefined
}

const localStringConsts = (source: ts.SourceFile): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isStringLiteralLike(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    )
      out.set(node.name.text, node.initializer.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Every `bun test <repo test file>` a file spawns. */
export const nestedSuiteTargets = (input: NestedSuiteInput): readonly NestedSuiteTarget[] => {
  if (!input.text.includes('"test"') && !input.text.includes("'test'")) return []
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const consts = localStringConsts(source)
  const out: NestedSuiteTarget[] = []

  /** The repo-relative target a `bun test` argv element names, if any. */
  const repoTargetOf = (part: string | undefined): string | undefined => {
    if (part === undefined || part.startsWith("-") || !part.endsWith(".test.ts")) return undefined
    const abs = isAbsolute(part) ? part : join(input.repoRoot, part)
    if (!abs.startsWith(`${input.repoRoot}/`) || !existsSync(abs)) return undefined
    return abs.slice(input.repoRoot.length + 1)
  }

  const inspectArray = (array: ts.ArrayLiteralExpression, node: ts.Node): void => {
    const parts = array.elements.map((element) => literalOf(element, consts))
    if (parts[0] !== "bun" || !parts.slice(1).includes("test")) return
    for (const part of parts.slice(2)) {
      const target = repoTargetOf(part)
      if (target === undefined) continue
      out.push({
        file: input.path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        target,
      })
    }
  }

  /** `Bun.spawn({ cmd: [...] })` — the option-bag spelling of the same call. */
  const inspectOptionBag = (bag: ts.ObjectLiteralExpression, node: ts.Node): void => {
    for (const prop of bag.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
      if (prop.name.text !== "cmd") continue
      if (ts.isArrayLiteralExpression(prop.initializer)) inspectArray(prop.initializer, node)
    }
  }

  const inspectCall = (node: ts.CallExpression): void => {
    const name = rightmost(node.expression)
    if (name === undefined || !SPAWNERS.has(name)) return
    for (const arg of node.arguments) {
      if (ts.isArrayLiteralExpression(arg)) inspectArray(arg, node)
      else if (ts.isObjectLiteralExpression(arg)) inspectOptionBag(arg, node)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) inspectCall(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}
