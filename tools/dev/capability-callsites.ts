/**
 * `tools/dev/capability-callsites` — which capability ids the test corpus
 * actually ASKS FOR, read structurally.
 *
 * # Why this exists
 *
 * The capability receipt has two ends that can drift apart silently:
 *
 *   producer  `capability-probe-producer.ts` decides which capabilities get
 *             probed once per tier and written into the receipt.
 *   consumer  a test file calls `capability("lldb-dap")` and branches on the
 *             verdict.
 *
 * A typo, a rename, or a capability deleted from the catalogue does not fail to
 * compile: `capability()` takes a `string`, and an id nobody probed comes back
 * as `blocked-missing`, which is a VISIBLE SKIP. So the failure mode is the
 * worst one available — the suite stays green and quietly stops running the
 * cases. This module supplies the corpus half of a bidirectional drift guard.
 *
 * # Why an AST walk and not a grep
 *
 * `capability` is an ordinary identifier. A regex for `capability("…")` also
 * matches the string inside this file's own documentation, a `describe` title
 * that mentions the call, and any local helper that happens to share the name.
 * Only the parse can say "a CALL EXPRESSION whose callee is `capability`,
 * imported from the consumer module". That is the thing the drift guard is about.
 *
 * And the parse has to see EVERY such call, or say which ones it could not read.
 * The first version recognised one shape — a bare imported name and one string
 * literal — and skipped the rest silently, so a constant-bound id and a namespace
 * import were consumers no guard compared to anything. `capabilityCallProblems`
 * names each call shape the guard cannot vouch for.
 */

import ts from "typescript"

export const CAPABILITY_CONSUMER_MODULE = "capability-receipt-consumer"

export interface CapabilityCallsite {
  readonly file: string
  readonly capabilityId: string
  readonly line: number
}

export interface CapabilityCallsiteInput {
  readonly path: string
  readonly text: string
}

/** How `capability` is reachable in one file: bare local names and namespace names. */
interface ConsumerBindings {
  readonly names: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
}

const importsConsumer = (statement: ts.Statement): statement is ts.ImportDeclaration =>
  ts.isImportDeclaration(statement) &&
  ts.isStringLiteral(statement.moduleSpecifier) &&
  statement.moduleSpecifier.text.includes(CAPABILITY_CONSUMER_MODULE)

/**
 * Every binding through which this file can call `capability`. Empty means the
 * file does not consume the receipt, and a `capability(...)` in it is somebody
 * else's function.
 *
 * `import * as consumer` counts. The first version read only named clauses, so
 * `consumer.capability("x")` was a consumer the drift guard could not see.
 */
const consumerBindings = (source: ts.SourceFile): ConsumerBindings => {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!importsConsumer(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "capability") names.add(element.name.text)
    }
  }
  return { names, namespaces }
}

const callsConsumer = (node: ts.CallExpression, bindings: ConsumerBindings): boolean => {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return bindings.names.has(callee.text)
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text) &&
    callee.name.text === "capability"
  )
}

/** Module-scope `const X = "literal"` bindings, which name an id as surely as the literal. */
const moduleStringConstants = (source: ts.SourceFile): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer
      if (ts.isIdentifier(declaration.name) && init !== undefined && ts.isStringLiteralLike(init)) {
        out.set(declaration.name.text, init.text)
      }
    }
  }
  return out
}

const insideFunction = (node: ts.Node): boolean => {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionLike(at)) return true
  }
  return false
}

const isLogical = (node: ts.Node): boolean =>
  ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)

/**
 * Under a branch or a loop. `const d = gate ? capability("git") : undefined` at
 * module scope decides whether the file consults the receipt at all — the
 * short-circuit the requirement moved into `capability()` to avoid.
 */
const underCondition = (node: ts.Node): boolean => {
  for (let at = node.parent; at !== undefined && !ts.isSourceFile(at); at = at.parent) {
    if (
      ts.isConditionalExpression(at) ||
      ts.isIfStatement(at) ||
      ts.isSwitchStatement(at) ||
      ts.isIterationStatement(at, false) ||
      isLogical(at)
    ) {
      return true
    }
  }
  return false
}

const isProcessEnv = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "process" &&
  node.name.text === "env"

/**
 * Every way the consumer's `capability` escapes a direct call, which no call
 * classification can see: an alias (`const ask = capability`), `.call`,
 * `(capability)(…)`, `capability!(…)`, `consumer["capability"]`, a dynamic
 * `import()` or `require()` of the module, or a re-export of it.
 */
const namesConsumerModule = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isStringLiteralLike(node) &&
  node.text.includes(CAPABILITY_CONSUMER_MODULE)

/** `import("…consumer")`, `require("…consumer")`, or `export … from "…consumer"`. */
const reachesModuleIndirectly = (node: ts.Node): boolean =>
  (ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    namesConsumerModule(node.arguments[0])) ||
  (ts.isExportDeclaration(node) && namesConsumerModule(node.moduleSpecifier))

/** A NAME in a declaration or member position, which is not a use of the binding. */
const isNamePosition = (node: ts.Identifier): boolean => {
  const parent = node.parent
  return (
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node)
  )
}

/** Any use of an imported binding other than calling it, or `ns.capability(…)`. */
const isIndirectReference = (node: ts.Identifier, bindings: ConsumerBindings): boolean => {
  if (isNamePosition(node)) return false
  const parent = node.parent
  if (bindings.names.has(node.text)) {
    return !(ts.isCallExpression(parent) && parent.expression === node)
  }
  if (!bindings.namespaces.has(node.text)) return false
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return true
  if (parent.name.text !== "capability") return false
  return !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
}

/**
 * Every way the consumer's `capability` escapes a direct call, which no call
 * classification can see: an alias (`const ask = capability`), `.call`,
 * `(capability)(…)`, `capability!(…)`, `consumer["capability"]`, a dynamic
 * `import()` or `require()` of the module, or a re-export of it.
 */
const indirectUses = (source: ts.SourceFile, bindings: ConsumerBindings): readonly ts.Node[] => {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (reachesModuleIndirectly(node)) found.push(node)
    if (ts.isIdentifier(node) && isIndirectReference(node, bindings)) found.push(node)
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return found
}

/** A literal id, or one bound by a module-scope string constant. */
const staticId = (
  argument: ts.Expression | undefined,
  constants: ReadonlyMap<string, string>,
): string | undefined => {
  if (argument === undefined) return undefined
  if (ts.isStringLiteralLike(argument)) return argument.text
  return ts.isIdentifier(argument) ? constants.get(argument.text) : undefined
}

/** One call of the consumer's `capability`, whatever its shape. */
export interface CapabilityCall {
  readonly file: string
  readonly line: number
  /** `undefined` when the id cannot be read statically. */
  readonly capabilityId: string | undefined
  /**
   * One argument: the call reads the AMBIENT receipt, `process.env`'s — the
   * campaign's. A second argument is an explicit env, which is how the mechanism's
   * own tests drive it, and such a call does not consume the campaign receipt.
   */
  readonly ambient: boolean
  readonly moduleScope: boolean
  /** Under a branch or loop at any scope (see `underCondition`). */
  readonly conditional: boolean
}

export const capabilityCalls = (input: CapabilityCallsiteInput): readonly CapabilityCall[] => {
  // Sound, not a heuristic: a file that can call the consumer's `capability` has an
  // import specifier containing this text. Parsing all ~4,000 corpus files to
  // learn that was most of this scan's cost.
  if (!input.text.includes(CAPABILITY_CONSUMER_MODULE)) return []
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const bindings = consumerBindings(source)
  if (bindings.names.size === 0 && bindings.namespaces.size === 0) return []
  const constants = moduleStringConstants(source)
  const out: CapabilityCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callsConsumer(node, bindings)) {
      const capabilityId = staticId(node.arguments[0], constants)
      out.push({
        file: input.path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        capabilityId,
        // `capability(id, process.env)` reads the ambient receipt exactly like the
        // one-argument form; only an injected env is the mechanism's own test.
        ambient: node.arguments.length === 1 || isProcessEnv(node.arguments[1]),
        moduleScope: !insideFunction(node),
        conditional: underCondition(node),
      })
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return out
}

/** Every ambient `capability(<id>)` call whose id is statically known, in one file. */
export const capabilityCallsites = (
  input: CapabilityCallsiteInput,
): readonly CapabilityCallsite[] =>
  capabilityCalls(input).flatMap((call) =>
    call.ambient && call.capabilityId !== undefined
      ? [{ file: call.file, capabilityId: call.capabilityId, line: call.line }]
      : [],
  )

export type CapabilityCallProblem =
  | "unresolved-id"
  | "ambient-call-inside-a-function"
  | "conditional-call"
  | "indirect-use"

/**
 * The call shapes the drift guard cannot vouch for.
 *
 *  - `unresolved-id`: an ambient call whose id is neither a literal nor a
 *    module-scope string constant. The id-drift guard reads only ids it can see,
 *    so this call could ask for anything and nothing would compare it to the
 *    catalogue.
 *  - `ambient-call-inside-a-function`: the receipt is consulted when that function
 *    runs, if it runs. Inside a test body the requirement can no longer register
 *    a failing test and throws instead; inside a helper, whether the file consults
 *    the receipt at all depends on a code path. Every consumer asks at module
 *    scope, where the answer is decided once, before any test is selected.
 */
const callProblems = (call: CapabilityCall): readonly CapabilityCallProblem[] => {
  if (!call.ambient) return []
  const checks: readonly [boolean, CapabilityCallProblem][] = [
    [call.capabilityId === undefined, "unresolved-id"],
    [!call.moduleScope, "ambient-call-inside-a-function"],
    [call.conditional, "conditional-call"],
  ]
  return checks.flatMap(([failed, problem]) => (failed ? [problem] : []))
}

export const capabilityCallProblems = (
  inputs: readonly CapabilityCallsiteInput[],
): readonly string[] =>
  inputs
    .flatMap((input) => [
      ...capabilityCalls(input).flatMap((call) =>
        callProblems(call).map((problem) => `${call.file}:${call.line} ${problem}`),
      ),
      ...indirectUseLines(input).map((line) => `${input.path}:${line} indirect-use`),
    ])
    .sort()

const indirectUseLines = (input: CapabilityCallsiteInput): readonly number[] => {
  if (!input.text.includes(CAPABILITY_CONSUMER_MODULE)) return []
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  return indirectUses(source, consumerBindings(source)).map(
    (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  )
}

export const scanCapabilityCallsites = (
  inputs: readonly CapabilityCallsiteInput[],
): readonly CapabilityCallsite[] =>
  inputs
    .flatMap((input) => capabilityCallsites(input))
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.capabilityId.localeCompare(b.capabilityId),
    )
