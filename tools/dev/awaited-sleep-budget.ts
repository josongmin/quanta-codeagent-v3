/**
 * `tools/dev/awaited-sleep-budget` — how much REAL TIME a test file spends
 * waiting on a fixed timer, summed per file.
 *
 * # Why the aggregate and not the site
 *
 * `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` had sixteen awaited fixed sleeps
 * totalling 22,875 ms, and the discussion around it kept circling the single
 * 16,000 ms one. Deleting that site leaves 6,875 ms — an improvement nobody can
 * feel, spread across fifteen guesses that are each individually defensible.
 * That is the failure mode of a per-site rule: every site passes it, and the
 * file is still the slowest thing in the tier.
 *
 * The budget is therefore per FILE, over the SUM, which is the quantity a
 * reader actually experiences and the one a scheduler has to plan around.
 *
 * # What counts
 *
 *   · `await sleep(1000)` / `await Bun.sleep(1000)` / `await delay(1000)` —
 *     an awaited call to a local or imported sleep with a literal argument.
 *   · `await new Promise(r => setTimeout(r, 1000))` written inline.
 *
 * # What does not, and why
 *
 *   · `Promise.race([proc.exited, sleep(3000)])` — that is a TIMEOUT, an upper
 *     bound on something that normally finishes far sooner. Charging it as 3,000
 *     ms of wait would make the honest shape look worse than the guess it
 *     replaces, which is how a rule teaches people to write the guess.
 *   · a sleep inside a polling loop (`while (…) { … await sleep(25) }`) — that
 *     is a poll INTERVAL, paid only until the predicate holds. Charging the
 *     interval as a fixed cost would push authors toward longer intervals, i.e.
 *     toward a slower, coarser wait.
 *   · a non-literal argument — the analyzer does not invent a number.
 *
 * The two exclusions are the reason this is a parse. Textually, the awaited
 * `sleep(3_000)` inside a `Promise.race` and the awaited `sleep(3_000)` on its
 * own line are the same characters.
 */

import ts from "typescript"

export interface AwaitedSleep {
  readonly line: number
  readonly ms: number
  /** The call as written, for the message. */
  readonly text: string
}

export interface AwaitedSleepInput {
  readonly path: string
  readonly text: string
}

const SLEEP_NAMES: ReadonlySet<string> = new Set(["sleep", "delay", "wait", "pause"])

const rightmost = (expr: ts.Expression): string | undefined =>
  ts.isIdentifier(expr)
    ? expr.text
    : ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : undefined

/** A numeric literal, including the `16_000` spelling. */
const literalMs = (node: ts.Expression | undefined): number | undefined => {
  if (node === undefined) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""))
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text.replaceAll("_", ""))
  return undefined
}

/** `new Promise(r => setTimeout(r, N))` — the inline spelling. */
const inlineTimeoutMs = (node: ts.Expression): number | undefined => {
  if (!ts.isNewExpression(node) || rightmost(node.expression) !== "Promise") return undefined
  let found: number | undefined
  const visit = (inner: ts.Node): void => {
    if (
      ts.isCallExpression(inner) &&
      rightmost(inner.expression) === "setTimeout" &&
      inner.arguments.length >= 2
    ) {
      const ms = literalMs(inner.arguments[1])
      if (ms !== undefined) found = ms
    }
    ts.forEachChild(inner, visit)
  }
  visit(node)
  return found
}

/** True when `node` sits inside a loop — a poll interval, not a fixed wait. */
const insideLoop = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current)
    )
      return true
    current = current.parent
  }
  return false
}

/** True when `node` is an argument of `Promise.race`/`Promise.any` — a bound. */
const insideRaceBound = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (ts.isCallExpression(current)) {
      const name = rightmost(current.expression)
      if (name === "race" || name === "any" || name === "withTimeout") return true
    }
    current = current.parent
  }
  return false
}

/** The milliseconds an awaited expression really waits, or undefined. */
const awaitedMs = (operand: ts.Expression): number | undefined => {
  if (!ts.isCallExpression(operand)) return inlineTimeoutMs(operand)
  const name = rightmost(operand.expression)
  if (name === undefined || !SLEEP_NAMES.has(name)) return undefined
  return literalMs(operand.arguments[0])
}

/** Every awaited fixed-duration wait in one file, with its milliseconds. */
export const awaitedSleeps = (input: AwaitedSleepInput): readonly AwaitedSleep[] => {
  if (!input.text.includes("sleep") && !input.text.includes("setTimeout")) return []
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const out: AwaitedSleep[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const ms = awaitedMs(node.expression)
      // A poll INTERVAL and a `Promise.race` BOUND are not fixed waits — see
      // the header. The charged node is the call, not the `await`, so the
      // reported line points at the duration.
      if (ms !== undefined && ms > 0 && !insideLoop(node) && !insideRaceBound(node))
        out.push({
          line: source.getLineAndCharacterOfPosition(node.expression.getStart(source)).line + 1,
          ms,
          text: node.expression.getText(source).slice(0, 80),
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** The per-file total this budget gates. */
export const awaitedSleepTotalMs = (input: AwaitedSleepInput): number =>
  awaitedSleeps(input).reduce((total, site) => total + site.ms, 0)
