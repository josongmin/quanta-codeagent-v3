/**
 * `tools/dev/temp-lifecycle` — does every `mkdtemp` in the test corpus have an
 * owner that removes it, in a place that runs even when the test fails?
 *
 * # The gap this closes
 *
 * `tests/unit/test-fixtures-do-not-leak-tmp.test.ts` already forbids one
 * spelling of the defect: cleanup registered with `process.on("exit")`, which
 * bun's test runner never fires. That guard reads the WRONG half of the pair —
 * it looks for a hook and complains about the hook's kind. A file with no
 * cleanup at all has no hook, so it is invisible to that guard, and a file whose
 * `rmSync` sits after three `expect`s has an ordinary-looking cleanup that is
 * skipped by the first failure.
 *
 * MEASURED at the time of writing: 8 ordinary test files created temp roots at
 * 20 call sites with no `rm` anywhere in the file, and the exit-hook guard was
 * green on all of them.
 *
 * The consequence is not disk. It is that `/tmp` grows until `ls /tmp` is slow
 * enough to time OTHER tests out — the incident already written up at the top of
 * the exit-hook guard, where one file alone left 790 directories.
 *
 * # Why this is a parse and not a grep
 *
 * The question is a SCOPE question, and scope is the one thing text cannot see:
 *
 *   · `rmSync(dir)` at the end of a test body is real cleanup that never runs
 *     when an earlier `expect` throws. Textually it is identical to the correct
 *     version one line lower inside a `finally`.
 *   · `const repo = await makeRepo()` creates a temp dir, and the word
 *     `mkdtemp` does not appear on that line — it is inside `makeRepo`.
 *   · `rmSync(join(dir, "sub"))` mentions the binding and removes something
 *     else.
 *
 * A regex that flagged the first would also flag every legitimate `rmSync`, and
 * a regex that did not flag it would be checking nothing. So the analyzer walks
 * the AST: it resolves the OWNING BINDING of each temp root, finds the
 * disposals that name that binding, and asks whether the disposal's enclosing
 * scope is one that runs unconditionally (`finally`, `afterEach`, `afterAll`,
 * `onTestFinished`, `.finally()`), or merely usually.
 *
 * # Deliberate asymmetry
 *
 * Where the analyzer cannot decide, it reports CLEAN. A guard that invents
 * findings gets an allowlist entry per false positive and stops meaning
 * anything; a guard that misses a case still holds the line for the cases it
 * sees. The anti-vacuum floor and the two injections in the consuming test are
 * what keep "reports clean" from becoming "reads nothing".
 */

import ts from "typescript"

/** How a temp root's disposal relates to the failure of the test that made it. */
export type TempDisposition =
  /** A disposal naming this root runs from `finally`/`afterEach`/`afterAll`. */
  | "cleaned"
  /** A disposal exists but only on the success path — the first failing
   *  `expect` above it leaks the root. */
  | "unguarded"
  /** No disposal names this root anywhere in the file. */
  | "leaked"
  /** The root is handed to the caller (`return mkdtempSync(...)`); the call
   *  sites of the enclosing function are re-analyzed as temp sites instead. */
  | "transferred"
  /** Created and immediately discarded — no binding to dispose of. */
  | "unowned"

export interface TempSite {
  readonly file: string
  readonly line: number
  /** The identifier that holds the root, when there is one. */
  readonly binding: string | undefined
  readonly disposition: TempDisposition
  /** Why the analyzer decided that, in one clause. Never empty. */
  readonly reason: string
  /** The site is at module scope — it runs on import, before any hook can
   *  register, and no `afterAll` in a file that merely imports it will fire. */
  readonly moduleScope: boolean
  /** `mkdtemp` reached through a local factory rather than written inline. */
  readonly viaFactory: string | undefined
}

export interface TempLifecycleInput {
  readonly path: string
  readonly text: string
}

/** The two node-fs spellings. Matched on the rightmost name so `fs.mkdtempSync`,
 *  `fsp.mkdtemp` and a bare import all resolve the same. */
const MKDTEMP_NAMES: ReadonlySet<string> = new Set(["mkdtemp", "mkdtempSync"])

/**
 * Calls that remove a directory tree. `rm`/`rmSync` with `recursive` is the
 * repo's idiom; `rmdir` and the `rimraf` shim appear in older files.
 */
const DISPOSAL_NAMES: ReadonlySet<string> = new Set([
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "rimraf",
  "rimrafSync",
  "remove",
  "removeSync",
])

/**
 * Callbacks bun runs whatever the body did. `onTestFinished` is bun ≥1.1's
 * per-case form and is the correct answer for a root made inside one test.
 */
const UNCONDITIONAL_HOOKS: ReadonlySet<string> = new Set([
  "afterEach",
  "afterAll",
  "onTestFinished",
  "onTestFailed",
])

/** The ownership-transferring helper this repo offers; see
 *  `tests/_helpers/temp-dir.ts`. Its own body owns the `finally`. */
export const OWNING_HELPERS: ReadonlySet<string> = new Set([
  "withTempDir",
  "withTempDirSync",
  "useTempDir",
])

const rightmostName = (expr: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression))
    return expr.argumentExpression.text
  return undefined
}

const calleeName = (call: ts.CallExpression): string | undefined => rightmostName(call.expression)

/** Every identifier appearing anywhere inside a node. */
const identifiersIn = (node: ts.Node): ReadonlySet<string> => {
  const out = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/**
 * The FIRST argument's identifiers only. `rmSync(dir, { recursive: true })`
 * disposes of `dir`; the options object never names the thing being removed, and
 * counting it would let `rmSync(other, { maxRetries: dir })` read as cleanup.
 */
const disposalTargets = (call: ts.CallExpression): ReadonlySet<string> => {
  const first = call.arguments[0]
  return first === undefined ? new Set<string>() : identifiersIn(first)
}

interface Ownership {
  readonly binding: string | undefined
  readonly transferred: boolean
}

/**
 * Climb from the `mkdtemp` call to whatever holds its result.
 *
 * `await`, parentheses and type assertions are transparent. A wrapping CALL is
 * transparent too (`realpathSync(mkdtempSync(...))` is still the root, and
 * `join(mkdtempSync(...), "x")` is a path INSIDE it whose disposal is not the
 * root's) — the wrapping case is followed so the binding is found, and the
 * conservative consequence is that removing the joined child reads as removing
 * the root. That direction is chosen deliberately: see the header.
 */
/** `await x`, `(x)`, `x as T`, `x!` — none of them change who owns the root. */
const isTransparentWrapper = (parent: ts.Node): boolean =>
  ts.isAwaitExpression(parent) ||
  ts.isParenthesizedExpression(parent) ||
  ts.isAsExpression(parent) ||
  ts.isNonNullExpression(parent) ||
  ts.isTypeAssertionExpression(parent)

/** The binding a single parent node establishes, or `undefined` if it does not
 *  establish one. Split out of the climb so each half stays readable. */
const bindingFromParent = (parent: ts.Node, node: ts.Node): Ownership | undefined => {
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return { binding: parent.name.text, transferred: false }
  // `dir = mkdtempSync(...)` — the temp root is the RIGHT operand and the
  // binding is on the left. Testing `parent.left === node` here instead was a
  // real bug in this analyzer: it made every `let dir` + `beforeEach` assignment
  // read as `unowned`, which is the single most common CORRECT shape in the
  // corpus (agent-loop, bench, resume-e2e …). 148 sites misreported.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  )
    return { binding: rightmostName(parent.left), transferred: false }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
    return { binding: parent.name.text, transferred: false }
  if (ts.isReturnStatement(parent)) return { binding: undefined, transferred: true }
  if (ts.isArrowFunction(parent) && parent.body === node)
    return { binding: undefined, transferred: true }
  return undefined
}

const UNOWNED: Ownership = { binding: undefined, transferred: false }

const ownershipOf = (call: ts.CallExpression): Ownership => {
  let node: ts.Node = call
  let parent: ts.Node | undefined = node.parent
  while (parent !== undefined) {
    const transparent =
      isTransparentWrapper(parent) || (ts.isCallExpression(parent) && parent.expression !== node)
    if (transparent) {
      node = parent
      parent = parent.parent
      continue
    }
    return bindingFromParent(parent, node) ?? UNOWNED
  }
  return UNOWNED
}

/** The function-ish node that lexically contains `node`, or undefined at module
 *  scope. */
const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    )
      return current
    current = current.parent
  }
  return undefined
}

/** The name a function-ish node is reachable by: `function f()`, `const f = …`,
 *  or `{ f() {} }`. Used to turn `return mkdtemp(...)` into a factory. */
const functionName = (fn: ts.Node): string | undefined => {
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.text
  const parent = fn.parent
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text
  if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
    return parent.name.text
  return undefined
}

/**
 * Does this node sit in a scope that runs even when an assertion above it
 * throws?
 *
 * Three yeses:
 *   · inside a `try`'s `finally` block;
 *   · inside the callback of `afterEach` / `afterAll` / `onTestFinished`;
 *   · inside a `.finally(cb)` callback.
 *
 * Note the `finally` test is on the FINALLY BLOCK, not on "somewhere under a
 * try" — cleanup in the `try` body is exactly the defect.
 */
const isUnconditionalScope = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node
  let child: ts.Node | undefined
  while (current !== undefined) {
    if (ts.isTryStatement(current) && child !== undefined && current.finallyBlock === child)
      return true
    if (ts.isCallExpression(current)) {
      const name = calleeName(current)
      if (name !== undefined && UNCONDITIONAL_HOOKS.has(name)) return true
      if (name === "finally" && ts.isPropertyAccessExpression(current.expression)) return true
    }
    child = current
    current = current.parent
  }
  return false
}

/** Line number (1-based) of a node's start. */
const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

interface Disposal {
  readonly targets: ReadonlySet<string>
  readonly unconditional: boolean
}

/**
 * The ESCROW shape, which is correct and which a binding-name match cannot see:
 *
 *     const made: string[] = []
 *     …
 *     const source = mkdtempSync(…); made.push(source)
 *     afterAll(() => { for (const d of made) rmSync(d, { recursive: true }) })
 *
 * The disposal's argument is `d`, a loop variable — the root's binding never
 * appears next to an `rm` anywhere. Treating this as a leak would put six
 * correct files on a burndown list and teach the next reader that the list is
 * noise. So: a binding handed to an array, where that array is READ inside an
 * unconditional region that performs a disposal, is disposed of.
 */
const escrowArraysOf = (source: ts.SourceFile): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "push" || node.expression.name.text === "add") &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const container = node.expression.expression.text
      for (const arg of node.arguments) {
        if (!ts.isIdentifier(arg)) continue
        const set = out.get(arg.text) ?? new Set<string>()
        set.add(container)
        out.set(arg.text, set)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** The nearest enclosing node that runs unconditionally — a `finally` block or
 *  an `afterEach`/`afterAll`/`onTestFinished` callback. */
const unconditionalRegion = (node: ts.Node): ts.Node | undefined => {
  let current: ts.Node | undefined = node
  let child: ts.Node | undefined
  while (current !== undefined) {
    if (ts.isTryStatement(current) && child !== undefined && current.finallyBlock === child)
      return current.finallyBlock
    if (ts.isCallExpression(current)) {
      const name = calleeName(current)
      if (name !== undefined && UNCONDITIONAL_HOOKS.has(name)) return current
      if (name === "finally" && ts.isPropertyAccessExpression(current.expression)) return current
    }
    child = current
    current = current.parent
  }
  return undefined
}

/**
 * Disposals reachable from an unconditional scope INDIRECTLY: a named local
 * cleanup function whose identifier is invoked from an `afterAll`/`finally`.
 * One hop only — deeper indirection is rare and guessing at it would be the
 * analyzer inventing an answer.
 */
const indirectlyUnconditional = (
  disposalFn: ts.Node | undefined,
  invocationsInUnconditional: ReadonlySet<string>,
): boolean => {
  if (disposalFn === undefined) return false
  const name = functionName(disposalFn)
  return name !== undefined && invocationsInUnconditional.has(name)
}

/**
 * Classify the inline `mkdtemp` calls, pushing each site into `sites`, and
 * return the names of the local functions that RETURN a temp root — the
 * factories whose call sites are analyzed next.
 */
const factoriesFrom = (
  file: string,
  source: ts.SourceFile,
  index: DisposalIndex,
  calls: CallIndex,
  sites: TempSite[],
): ReadonlySet<string> => {
  const factories = new Set<string>()
  for (const call of calls.mkdtemp) {
    const site = classifySite(file, source, index, call, ownershipOf(call), undefined)
    sites.push(site)
    if (site.disposition !== "transferred") continue
    const fn = enclosingFunction(call)
    const name = fn === undefined ? undefined : functionName(fn)
    if (name !== undefined) factories.add(name)
  }
  return factories
}

/**
 * Analyze one file. Pure: takes text, returns findings, touches no disk.
 */
interface CallIndex {
  readonly mkdtemp: readonly ts.CallExpression[]
  readonly disposal: readonly ts.CallExpression[]
  readonly owningHelper: readonly ts.CallExpression[]
  readonly all: readonly ts.CallExpression[]
}

const indexCalls = (source: ts.SourceFile): CallIndex => {
  const mkdtemp: ts.CallExpression[] = []
  const disposal: ts.CallExpression[] = []
  const owningHelper: ts.CallExpression[] = []
  const all: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      all.push(node)
      const name = calleeName(node)
      if (name !== undefined && MKDTEMP_NAMES.has(name)) mkdtemp.push(node)
      else if (name !== undefined && DISPOSAL_NAMES.has(name)) disposal.push(node)
      else if (name !== undefined && OWNING_HELPERS.has(name)) owningHelper.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { mkdtemp, disposal, owningHelper, all }
}

/** Everything the classifier needs to answer "is this root disposed of, and
 *  does the disposal run when the test fails?". */
interface DisposalIndex {
  readonly helperOwned: ReadonlySet<string>
  readonly isEscrowed: (binding: string) => boolean
  readonly disposalFor: (binding: string) => {
    readonly any: boolean
    readonly unconditional: boolean
  }
}

const indexDisposals = (source: ts.SourceFile, calls: CallIndex): DisposalIndex => {
  const invokedFromUnconditional = new Set<string>()
  for (const call of calls.all) {
    if (!isUnconditionalScope(call)) continue
    const name = calleeName(call)
    if (name !== undefined) invokedFromUnconditional.add(name)
  }

  const disposals: readonly Disposal[] = calls.disposal.map((call) => ({
    targets: disposalTargets(call),
    unconditional:
      isUnconditionalScope(call) ||
      indirectlyUnconditional(enclosingFunction(call), invokedFromUnconditional),
  }))

  const helperOwned = new Set<string>()
  for (const call of calls.owningHelper) for (const id of identifiersIn(call)) helperOwned.add(id)

  const escrowArrays = escrowArraysOf(source)
  const sweptContainers = new Set<string>()
  for (const call of calls.disposal) {
    const region = unconditionalRegion(call)
    if (region === undefined) continue
    for (const id of identifiersIn(region)) sweptContainers.add(id)
  }

  return {
    helperOwned,
    isEscrowed: (binding) => {
      const containers = escrowArrays.get(binding)
      if (containers === undefined) return false
      for (const container of containers) if (sweptContainers.has(container)) return true
      return false
    },
    disposalFor: (binding) => {
      let any = false
      for (const disposal of disposals) {
        if (!disposal.targets.has(binding)) continue
        any = true
        if (disposal.unconditional) return { any: true, unconditional: true }
      }
      return { any, unconditional: false }
    },
  }
}

const classifySite = (
  file: string,
  source: ts.SourceFile,
  index: DisposalIndex,
  node: ts.Node,
  ownership: Ownership,
  viaFactory: string | undefined,
): TempSite => {
  const base = {
    file,
    line: lineOf(source, node),
    moduleScope: enclosingFunction(node) === undefined,
    viaFactory,
  }
  if (ownership.transferred)
    return {
      ...base,
      binding: undefined,
      disposition: "transferred",
      reason: "returned to the caller; the caller's binding is analyzed instead",
    }
  if (ownership.binding === undefined)
    return {
      ...base,
      binding: undefined,
      disposition: "unowned",
      reason: "the result is not bound to anything, so nothing can dispose of it",
    }
  const binding = ownership.binding
  if (index.helperOwned.has(binding))
    return {
      ...base,
      binding,
      disposition: "cleaned",
      reason: `passed to an owning helper (${[...OWNING_HELPERS].join("/")})`,
    }
  if (index.isEscrowed(binding))
    return {
      ...base,
      binding,
      disposition: "cleaned",
      reason: "handed to a container an unconditional region sweeps",
    }
  const found = index.disposalFor(binding)
  if (found.unconditional)
    return {
      ...base,
      binding,
      disposition: "cleaned",
      reason: "disposed from finally/afterEach/afterAll",
    }
  if (found.any)
    return {
      ...base,
      binding,
      disposition: "unguarded",
      reason: "disposed only on the success path — a failing assertion above it leaks the root",
    }
  return {
    ...base,
    binding,
    disposition: "leaked",
    reason: "no rm/rmSync in this file names this binding",
  }
}

/**
 * Analyze one file. Pure: takes text, returns findings, touches no disk.
 */
export const tempSites = (input: TempLifecycleInput): readonly TempSite[] => {
  // A file with no `mkdtemp` anywhere in its TEXT cannot contain a temp site, and
  // 3,100 of the corpus's 4,070 test-adjacent files are in that position. Parsing
  // them costs ~6s of ordinary unit time to produce an empty array every time.
  // The check is a superset of the AST question (a `mkdtemp` inside a comment or
  // a string still triggers the parse, which then finds nothing), so it can only
  // save work, never hide a site.
  if (!input.text.includes("mkdtemp")) return []
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const calls = indexCalls(source)
  if (calls.mkdtemp.length === 0) return []
  const index = indexDisposals(source, calls)

  const sites: TempSite[] = []
  const factories = factoriesFrom(input.path, source, index, calls, sites)

  // A local factory (`const makeRepo = async () => mkdtemp(...)`) moves
  // ownership to its CALLERS, so each call to one is a temp site in its own
  // right. Without this, `const repo = await makeRepo()` — the shape in
  // `tests/unit/worktree.test.ts` and 40 other files — is invisible.
  for (const call of calls.all) {
    const name = calleeName(call)
    if (name === undefined || !factories.has(name)) continue
    const fn = enclosingFunction(call)
    if (fn !== undefined && functionName(fn) === name) continue // the declaration itself
    sites.push(classifySite(input.path, source, index, call, ownershipOf(call), name))
  }

  return sites
}

/** The dispositions that are defects. `transferred` and `unowned` are reported
 *  but are not leaks by themselves — `unowned` is a temp root nobody can name,
 *  which is rare and is surfaced under its own heading. */
export const LEAKING_DISPOSITIONS: ReadonlySet<TempDisposition> = new Set<TempDisposition>([
  "leaked",
  "unguarded",
  "unowned",
])

export const isLeak = (site: TempSite): boolean => LEAKING_DISPOSITIONS.has(site.disposition)
