/**
 * `tools/dev/test-determinism-scan` — the STRUCTURAL detector behind the
 * determinism ratchet (TVH-15 items 1-3).
 *
 * # Why this is an AST walk and not a grep
 *
 * The three things this finds are all defined by the SYNTACTIC POSITION a token
 * occupies, not by the token appearing:
 *
 *   - `Math.random()` inside `test("no fixture is drawn from Math.random()")`
 *     is a string literal. `tests/unit/src-no-sketchy-code.test.ts` and
 *     `tests/unit/nicknames.test.ts` exist to FORBID the call and therefore
 *     spell it out; a grep marks the guards as the violation.
 *   - `expect(x).toBeLessThan(20)` is a wall-clock judgment only when `x` is
 *     derived from a clock. `const t0 = Date.now()` … `expect(Date.now() - t0)`
 *     is three lines apart, so the link is a SCOPE lookup, not a line match.
 *   - "aggregate awaited sleep" is a sum over call sites, and `setTimeout(fn, 50)`
 *     versus `setTimeout(50)` put the number in different argument slots.
 *
 * So: one `ts.createSourceFile` per file, a scope chain for the time bindings,
 * and pure functions over the resulting site lists. Every consumer (inventory
 * generator, ratchet, tests) reads the same shapes.
 *
 * # What "outcome-relevant randomness" means here, exactly
 *
 * A `Math.random()` call is classified by what its VALUE can reach, structurally:
 *
 *   - `unreachable-guard` — it is compared against a constant outside `[0, 1)`
 *     (`Math.random() < 0`, `< -1`). The branch is dead by construction; the
 *     call only exists to keep a function a generator. Provable, not guessed.
 *   - `id-shaped` — every path out of the call is string shaping (a template
 *     span, `.toString(36)`, `+` with a string). The value becomes part of a
 *     NAME (a temp path, a request id) and no numeric comparison sees it.
 *   - `outcome-relevant` — everything else: a comparator, a sort key, a delay,
 *     a score, a pid. These are the ones that make a case/order/delay
 *     irreproducible, which is the defect TVH-15 item 3 names.
 *
 * The classification is deliberately conservative: anything this cannot PROVE
 * is string-only or dead lands in `outcome-relevant`.
 */

import ts from "typescript"

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * How we know the `expect(...)` subject is a clock reading.
 *
 * `time-call` and `time-binding` are PROVEN (the clock call is in the
 * expression, or in the expression a binding in scope was initialised from).
 * `duration-member` is a NAME judgment on a value produced elsewhere
 * (`result.elapsedMs`) — still a structural position, but the "is it a clock"
 * half is the identifier, which is why the inventory carries a per-site
 * classification instead of trusting this field.
 */
export type WallEvidence = "time-call" | "time-binding" | "duration-member"

export interface WallAssertionSite {
  readonly file: string
  readonly line: number
  readonly matcher: string
  /** Source text of the `expect()` argument. */
  readonly subject: string
  /** Source text of the matcher argument (the upper bound). */
  readonly bound: string
  readonly evidence: WallEvidence
}

export type RandomRole = "outcome-relevant" | "id-shaped" | "unreachable-guard"

export interface RandomSite {
  readonly file: string
  readonly line: number
  readonly role: RandomRole
  readonly snippet: string
}

export interface SleepSite {
  readonly file: string
  readonly line: number
  readonly callee: string
  readonly ms: number
}

export interface FileScan {
  readonly file: string
  readonly wall: readonly WallAssertionSite[]
  readonly random: readonly RandomSite[]
  readonly sleep: readonly SleepSite[]
  /** Sum of every awaited fixed-sleep literal in the file. */
  readonly sleepTotalMs: number
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Callee texts that read a clock. Absence of a name here is a false NEGATIVE,
 *  so the list is guarded by `tests/unit/dev/test-determinism-scan.test.ts`. */
export const TIME_CALL_TEXTS: ReadonlySet<string> = new Set([
  "Date.now",
  "performance.now",
  "performance.timeOrigin",
  "process.hrtime",
  "process.hrtime.bigint",
  "process.uptime",
  "Bun.nanoseconds",
])

/** Matchers that impose an UPPER bound — the direction that judges throughput. */
export const UPPER_BOUND_MATCHERS: ReadonlySet<string> = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
])

/** Identifier/property names that denote a measured interval. */
const DURATION_NAME =
  /^(elapsed|duration|took|latency|wall|spent|delta|runtime|waited)|(?:ms|millis|micros|nanos|seconds|duration|elapsed|latency|runtime)$/i

const SLEEP_CALL_TEXTS: ReadonlySet<string> = new Set([
  "sleep",
  "Bun.sleep",
  "delay",
  "setTimeout",
  "setTimeoutPromise",
  "wait",
  "waitMs",
  "pause",
])

const isTimeCall = (node: ts.Node, sf: ts.SourceFile): boolean => {
  if (!ts.isCallExpression(node) && !ts.isPropertyAccessExpression(node)) return false
  const callee = ts.isCallExpression(node) ? node.expression : node
  return TIME_CALL_TEXTS.has(callee.getText(sf))
}

const looksLikeDurationName = (name: string): boolean => DURATION_NAME.test(name)

// ---------------------------------------------------------------------------
// Scope chain — so `elapsed` resolves to the `Date.now()` it was assigned from
// ---------------------------------------------------------------------------

interface Scope {
  readonly names: Set<string>
  readonly parent: Scope | undefined
}

const newScope = (parent: Scope | undefined): Scope => ({ names: new Set(), parent })

const scopeHas = (scope: Scope | undefined, name: string): boolean => {
  for (let s = scope; s !== undefined; s = s.parent) if (s.names.has(name)) return true
  return false
}

const opensScope = (node: ts.Node): boolean =>
  ts.isBlock(node) ||
  ts.isSourceFile(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isCaseBlock(node)

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface WalkState {
  readonly sf: ts.SourceFile
  readonly file: string
  readonly wall: WallAssertionSite[]
  readonly random: RandomSite[]
  readonly sleep: SleepSite[]
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/**
 * Does this expression read a clock, directly or through a binding in scope?
 *
 * MEASURED over-taint this closes: `const r = await runCodeCell({ …, now })`
 * passes a clock INTO a call. The result is a code-cell outcome, not a
 * duration, and taking it as one made `expect(r.output.length).toBeLessThan(256)`
 * — a byte cap — read as a wall-clock assertion in `code-mode-hellgate` and
 * `code-mode-phase2-full-surface`.
 *
 * So inside a call's ARGUMENTS only a real clock CALL taints (`Number(
 * process.hrtime.bigint() - start)` is still a duration); a clock-derived
 * identifier handed to a function is an input, not an output.
 */
const isTimeDerived = (
  node: ts.Node,
  sf: ts.SourceFile,
  scope: Scope,
): WallEvidence | undefined => {
  let proven: WallEvidence | undefined
  const walk = (n: ts.Node, inCallArgs: boolean): void => {
    if (proven === "time-call") return
    if (isTimeCall(n, sf)) {
      proven = "time-call"
      return
    }
    if (!inCallArgs && ts.isIdentifier(n) && scopeHas(scope, n.text)) proven ??= "time-binding"
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      walk(n.expression, inCallArgs)
      for (const argument of n.arguments ?? []) walk(argument, true)
      return
    }
    n.forEachChild((child) => {
      walk(child, inCallArgs)
    })
  }
  walk(node, false)
  return proven
}

/** Name-shaped fallback: `result.elapsedMs`, `tookMs`, `d.durationMs`. */
const durationNameEvidence = (node: ts.Node): boolean => {
  if (ts.isIdentifier(node)) return looksLikeDurationName(node.text)
  if (ts.isPropertyAccessExpression(node)) return looksLikeDurationName(node.name.text)
  if (ts.isBinaryExpression(node)) {
    return durationNameEvidence(node.left) || durationNameEvidence(node.right)
  }
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) {
    return durationNameEvidence(node.expression)
  }
  return false
}

/** `expect(<subject>)…` — the argument, or undefined if this is not an expect call. */
const expectSubject = (node: ts.Node, sf: ts.SourceFile): ts.Expression | undefined => {
  let cursor: ts.Node = node
  // Unwind `.resolves` / `.rejects` / `.not` chains back to the `expect(...)` call.
  for (let depth = 0; depth < 6; depth += 1) {
    if (ts.isPropertyAccessExpression(cursor)) {
      cursor = cursor.expression
      continue
    }
    if (ts.isCallExpression(cursor) && cursor.expression.getText(sf) === "expect") {
      return cursor.arguments[0]
    }
    if (ts.isCallExpression(cursor)) {
      cursor = cursor.expression
      continue
    }
    return undefined
  }
  return undefined
}

const recordWall = (node: ts.CallExpression, state: WalkState, scope: Scope): void => {
  if (!ts.isPropertyAccessExpression(node.expression)) return
  const matcher = node.expression.name.text
  if (!UPPER_BOUND_MATCHERS.has(matcher)) return
  const subject = expectSubject(node.expression.expression, state.sf)
  if (subject === undefined) return
  const evidence =
    isTimeDerived(subject, state.sf, scope) ??
    (durationNameEvidence(subject) ? ("duration-member" as const) : undefined)
  if (evidence === undefined) return
  state.wall.push({
    file: state.file,
    line: lineOf(state.sf, node),
    matcher,
    subject: subject.getText(state.sf).replace(/\s+/g, " ").slice(0, 160),
    bound: (node.arguments[0]?.getText(state.sf) ?? "").replace(/\s+/g, " ").slice(0, 80),
    evidence,
  })
}

// ---------------------------------------------------------------------------
// Randomness classification
// ---------------------------------------------------------------------------

const DEAD_COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
])

/** `Math.random() < 0` / `< -1` — the branch cannot be taken. */
const isDeadComparison = (parent: ts.Node, sf: ts.SourceFile): boolean => {
  if (!ts.isBinaryExpression(parent)) return false
  if (!DEAD_COMPARISONS.has(parent.operatorToken.kind)) return false
  const right = parent.right.getText(sf).trim()
  const value = Number(right)
  return Number.isFinite(value) && value <= 0
}

/** Methods whose RESULT is a string — past one of these the numeric value of
 *  `Math.random()` can no longer be compared, summed or used as a sort key. */
const STRINGIFYING_METHODS: ReadonlySet<string> = new Set([
  "toString",
  "toFixed",
  "toPrecision",
  "toLocaleString",
])

const isStringShaping = (node: ts.Node, sf: ts.SourceFile): boolean => {
  if (ts.isTemplateSpan(node) || ts.isTemplateExpression(node)) return true
  if (ts.isPropertyAccessExpression(node)) return STRINGIFYING_METHODS.has(node.name.text)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const other = node.left.getText(sf) + node.right.getText(sf)
    return other.includes('"') || other.includes("`") || other.includes("'")
  }
  return false
}

/**
 * Walk OUT from the call: the role is decided by the first parent that either
 * proves the value is dead, or proves it only ever becomes a string. Any other
 * parent (a comparison, an arithmetic op feeding a non-string, a call argument)
 * stops the walk at `outcome-relevant`.
 */
const classifyRandom = (call: ts.Node, sf: ts.SourceFile): RandomRole => {
  let node: ts.Node = call
  let parent = node.parent
  for (let depth = 0; depth < 8 && parent !== undefined; depth += 1) {
    if (isDeadComparison(parent, sf)) return "unreachable-guard"
    if (isStringShaping(parent, sf)) return "id-shaped"
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) {
      node = parent
      parent = parent.parent
      continue
    }
    // `Math.floor(Math.random() * n)` / `Math.round(...)` keep it numeric.
    if (
      ts.isCallExpression(parent) ||
      ts.isBinaryExpression(parent) ||
      ts.isPropertyAccessExpression(parent)
    ) {
      node = parent
      parent = parent.parent
      continue
    }
    return "outcome-relevant"
  }
  return "outcome-relevant"
}

const recordRandom = (node: ts.CallExpression, state: WalkState): void => {
  if (node.expression.getText(state.sf) !== "Math.random") return
  state.random.push({
    file: state.file,
    line: lineOf(state.sf, node),
    role: classifyRandom(node, state.sf),
    snippet: (node.parent ?? node).getText(state.sf).replace(/\s+/g, " ").slice(0, 120),
  })
}

// ---------------------------------------------------------------------------
// Fixed-sleep aggregation
// ---------------------------------------------------------------------------

const numericArg = (node: ts.Expression | undefined): number | undefined => {
  if (node === undefined) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""))
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return node.operator === ts.SyntaxKind.MinusToken
      ? -Number(node.operand.text.replace(/_/g, ""))
      : Number(node.operand.text.replace(/_/g, ""))
  }
  return undefined
}

/** Inside an `await`, find every fixed-duration sleep and its literal ms. */
const collectSleeps = (awaited: ts.Node, state: WalkState): void => {
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(state.sf)
      const short = callee.split(".").pop() ?? callee
      if (SLEEP_CALL_TEXTS.has(callee) || SLEEP_CALL_TEXTS.has(short)) {
        // `setTimeout(fn, ms)` puts the number second; `setTimeout(ms)` first.
        const ms = numericArg(n.arguments[0]) ?? numericArg(n.arguments[1])
        if (ms !== undefined && ms > 0) {
          state.sleep.push({ file: state.file, line: lineOf(state.sf, n), callee: short, ms })
        }
      }
    }
    n.forEachChild(walk)
  }
  walk(awaited)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const declareTimeBindings = (node: ts.Node, state: WalkState, scope: Scope): void => {
  if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return
  if (!ts.isIdentifier(node.name)) return
  if (isTimeDerived(node.initializer, state.sf, scope) !== undefined)
    scope.names.add(node.name.text)
}

const visitNode = (node: ts.Node, state: WalkState, scope: Scope): void => {
  const childScope = opensScope(node) ? newScope(scope) : scope
  declareTimeBindings(node, state, childScope)
  if (ts.isCallExpression(node)) {
    recordWall(node, state, childScope)
    recordRandom(node, state)
  }
  if (ts.isAwaitExpression(node)) collectSleeps(node.expression, state)
  node.forEachChild((child) => {
    visitNode(child, state, childScope)
  })
}

export const scanTestSource = (file: string, text: string): FileScan => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const state: WalkState = { sf, file, wall: [], random: [], sleep: [] }
  visitNode(sf, state, newScope(undefined))
  return {
    file,
    wall: state.wall,
    random: state.random,
    sleep: state.sleep,
    sleepTotalMs: state.sleep.reduce((sum, site) => sum + site.ms, 0),
  }
}
