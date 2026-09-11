/**
 * `tools/dev/self-skip-sites` — a test whose body returns before it asserts
 * anything, found structurally.
 *
 * # The shape
 *
 * ```ts
 * test("checks the thing", () => {
 *   if (!toolAvailable) return      // ← bun counts this as a PASS
 *   …
 * })
 * ```
 *
 * bun has no way to know the body returned early, so the case is reported green
 * and does not appear in the skip counter. It is invisible in both places a
 * reader would look, and `test.skipIf(condition)` says the same thing legibly.
 *
 * # Why the regex it replaces was blind
 *
 * The previous detector was:
 *
 *     /\b(?:it|test)\s*\(\s*(["'`])…\1[^\n]*\)\s*=>\s*\{\s*\n\s*if\s*\(…\)\s*…return\b/
 *
 * `[^\n]*` between the title and the arrow means the whole header has to sit on
 * ONE LINE. The four guards in `tests/unit/worktree.test.ts` are written as
 *
 *     test(
 *       "rejects a non-git directory",
 *       async () => {
 *         if (!(await gitAvailable())) return
 *
 * — a form biome produces by itself whenever a per-test timeout is passed as a
 * third argument, because the call no longer fits in 100 columns. MEASURED: four
 * self-skipping cases in that file, all four recorded as PASS, and the ratchet
 * that exists to find exactly this was green on them. The formatter decided
 * whether the guard could see the file.
 *
 * A parse has no line-width opinion. It asks the only question that matters: is
 * the FIRST statement of this test's callback a conditional `return`?
 *
 * # Why only the first statement
 *
 * A conditional return LATER in a body is ordinary control flow over work the
 * test already did. One at the top is a skip wearing a pass. Matching anywhere
 * would flag hundreds of legitimate early exits and get the rule deleted rather
 * than followed.
 */

import ts from "typescript"

export interface SelfSkipSite {
  /** 1-based line of the `if` that decides not to run. */
  readonly line: number
  /** The test's title, when it is a literal — for a legible message. */
  readonly title: string
}

export interface SelfSkipInput {
  readonly path: string
  readonly text: string
}

/**
 * The base identifier of a callee chain: `test` for `test`, `test.only`,
 * `test.skipIf(x)`, `it.each(rows)`. A local helper called `runTest` is NOT a
 * test declaration and must not be matched.
 */
const calleeRoot = (expr: ts.Expression): string | undefined => {
  let current: ts.Expression = expr
  for (;;) {
    if (ts.isIdentifier(current)) return current.text
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isCallExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isTaggedTemplateExpression(current)) {
      current = current.tag
      continue
    }
    return undefined
  }
}

const TEST_ROOTS: ReadonlySet<string> = new Set(["test", "it"])

/** The callback a test call passes — the first function-valued argument. */
const testBody = (call: ts.CallExpression): ts.Block | undefined => {
  for (const arg of call.arguments) {
    if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue
    return arg.body !== undefined && ts.isBlock(arg.body) ? arg.body : undefined
  }
  return undefined
}

/** `if (c) return` / `if (c) { return }` — nothing else in the branch. */
const isGuardReturn = (statement: ts.Statement): statement is ts.IfStatement => {
  if (!ts.isIfStatement(statement)) return false
  if (statement.elseStatement !== undefined) return false
  const branch = statement.thenStatement
  if (ts.isReturnStatement(branch)) return true
  return (
    ts.isBlock(branch) &&
    branch.statements.length === 1 &&
    branch.statements[0] !== undefined &&
    ts.isReturnStatement(branch.statements[0] as ts.Statement)
  )
}

const titleOf = (call: ts.CallExpression): string => {
  const first = call.arguments[0]
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : "<non-literal title>"
}

/**
 * A cheap superset of the shape, used ONLY to decide whether parsing is worth
 * it. It matches an `if (…) return` anywhere in the file — including the
 * hundreds of legitimate mid-body guards the AST then rejects — so it cannot
 * hide a site; it just keeps the parser away from the ~2,900 files that have no
 * conditional return at all, which is the difference between a 6-second scan of
 * the corpus and a sub-second one.
 */
const COULD_CONTAIN = /\bif\s*\([^\n]*\)\s*(?:\{\s*\n\s*)?return\b/

/** Every test in one file whose body opens with a conditional `return`. */
export const selfSkipSites = (input: SelfSkipInput): readonly SelfSkipSite[] => {
  if (!COULD_CONTAIN.test(input.text)) return []
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const out: SelfSkipSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression)
      if (root !== undefined && TEST_ROOTS.has(root)) {
        const body = testBody(node)
        const first = body?.statements[0]
        if (first !== undefined && isGuardReturn(first))
          out.push({
            line: source.getLineAndCharacterOfPosition(first.getStart(source)).line + 1,
            title: titleOf(node),
          })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** Count only — the shape the previous ratchet consumed. */
export const selfSkipCount = (input: SelfSkipInput): number => selfSkipSites(input).length
