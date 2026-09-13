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

/** Every name a binding pattern introduces: `a`, `{ a, b: [c] }`. */
const bindingNames = (name: ts.BindingName): readonly string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
      )

/** The names a scope node declares for its own body. */
const declaredIn = (scope: ts.Node): readonly string[] => {
  if (ts.isFunctionLike(scope)) {
    const own = ts.isFunctionExpression(scope) && scope.name !== undefined ? [scope.name.text] : []
    return [...own, ...scope.parameters.flatMap((parameter) => bindingNames(parameter.name))]
  }
  if (ts.isCatchClause(scope)) {
    return scope.variableDeclaration === undefined
      ? []
      : bindingNames(scope.variableDeclaration.name)
  }
  if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
    const init = scope.initializer
    return init !== undefined && ts.isVariableDeclarationList(init)
      ? init.declarations.flatMap((declaration) => bindingNames(declaration.name))
      : []
  }
  if (!ts.isBlock(scope) && !ts.isCaseBlock(scope)) return []
  const statements = ts.isBlock(scope)
    ? scope.statements
    : scope.clauses.flatMap((clause) => [...clause.statements])
  return statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((one) => bindingNames(one.name))
    }
    return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
      ? [statement.name.text]
      : []
  })
}

/**
 * Does a scope between `node` and the module declare `name` again? Then `node`
 * names that local, not the import: `function f(capability: string) { capability }`.
 */
const shadowed = (node: ts.Node, name: string): boolean => {
  for (let at = node.parent; at !== undefined && !ts.isSourceFile(at); at = at.parent) {
    if (declaredIn(at).includes(name)) return true
  }
  return false
}

const callsConsumer = (node: ts.CallExpression, bindings: ConsumerBindings): boolean => {
  const callee = node.expression
  if (ts.isIdentifier(callee)) {
    return bindings.names.has(callee.text) && !shadowed(callee, callee.text)
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text) &&
    !shadowed(callee, callee.expression.text) &&
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

const SHORT_CIRCUIT: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/**
 * Does `parent` run `child` only on some paths, or more than once?
 *
 * By POSITION, not by ancestor kind. The first version flagged any ancestor
 * ternary or `&&`, so `canExecute(capability("git")) ? describe : describe.skip`
 * — the standard selector, where the call is the condition and always runs —
 * was a `conditional-call`, and so was `capability("git") ?? fallback`.
 */
const runsConditionally = (child: ts.Node, parent: ts.Node): boolean =>
  inStatementBranch(child, parent) || inExpressionBranch(child, parent)

/** A branch or a loop body; the tested expression itself always runs once. */
const inStatementBranch = (child: ts.Node, parent: ts.Node): boolean => {
  if (ts.isIfStatement(parent) || ts.isSwitchStatement(parent)) return child !== parent.expression
  if (ts.isForStatement(parent)) return child !== parent.initializer
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
    return child === parent.statement
  }
  return ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isCatchClause(parent)
}

const inExpressionBranch = (child: ts.Node, parent: ts.Node): boolean => {
  if (ts.isConditionalExpression(parent)) return child !== parent.condition
  if (ts.isBinaryExpression(parent)) {
    return SHORT_CIRCUIT.has(parent.operatorToken.kind) && child === parent.right
  }
  // `a?.b(capability("x"))` and `a?.[capability("x")]`: skipped when `a` is nullish.
  if (ts.isCallExpression(parent) || ts.isElementAccessExpression(parent)) {
    return child !== parent.expression && (parent.flags & ts.NodeFlags.OptionalChain) !== 0
  }
  // A default: `const { a = capability("x") } = o`, `(x = capability("y")) => …`.
  if (ts.isBindingElement(parent) || ts.isParameter(parent)) return child === parent.initializer
  return ts.isShorthandPropertyAssignment(parent) && child === parent.objectAssignmentInitializer
}

/**
 * Under a branch or a loop. `const d = gate ? capability("git") : undefined` at
 * module scope decides whether the file consults the receipt at all — the
 * short-circuit the requirement moved into `capability()` to avoid.
 */
const underCondition = (node: ts.Node): boolean => {
  for (let child = node, at = node.parent; at !== undefined; child = at, at = at.parent) {
    if (runsConditionally(child, at)) return true
  }
  return false
}

const unwrapExpression = (node: ts.Expression): ts.Expression => {
  let at = node
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isSatisfiesExpression(at) ||
    ts.isTypeAssertionExpression(at) ||
    ts.isNonNullExpression(at)
  ) {
    at = at.expression
  }
  return at
}

const AMBIENT_ROOTS: ReadonlySet<string> = new Set(["process", "Bun", "globalThis"])

/**
 * An object literal that cannot carry the campaign's receipt: no spread, no
 * shorthand (a bare name is a value the scan cannot see), and no value naming
 * `process`, `Bun` or `globalThis`.
 */
const isInertObjectLiteral = (node: ts.Expression): boolean => {
  if (!ts.isObjectLiteralExpression(node)) return false
  let inert = true
  const visit = (at: ts.Node): void => {
    if (ts.isSpreadAssignment(at) || ts.isShorthandPropertyAssignment(at)) inert = false
    if (ts.isIdentifier(at) && AMBIENT_ROOTS.has(at.text)) inert = false
    if (inert) at.forEachChild(visit)
  }
  node.forEachChild(visit)
  return inert
}

/**
 * Every binding of every variable name in the file: its initializer when it is an
 * initialised `const`, otherwise `undefined` (a `let`, a `var`, no initializer).
 */
const variableBindings = (
  source: ts.SourceFile,
): ReadonlyMap<string, readonly (ts.Expression | undefined)[]> => {
  const out = new Map<string, (ts.Expression | undefined)[]>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent)
    ) {
      const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0
      const list = out.get(node.name.text) ?? []
      list.push(isConst ? node.initializer : undefined)
      out.set(node.name.text, list)
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return out
}

/**
 * Is the env argument one the CAMPAIGN receipt cannot be in?
 *
 * Inverted. The first rule called a call ambient only when its second argument
 * was literally `process.env`, and treated everything else as the mechanism's own
 * injected env. `Bun.env` is the same object, and an alias or a spread carries the
 * same receipt — measured, each of `capability("x", Bun.env)`,
 * `const env = process.env; capability("x", env)` and
 * `capability("x", { ...process.env })` came back with no problem and no callsite.
 *
 * Now only what is provably inert is injected: an inert object literal, or a name
 * whose EVERY binding in the file is a `const` initialised to one (a name match,
 * not a scope resolution, so a second binding of the name must not be trusted).
 * Anything the scan cannot prove — a call's result, a parameter, a property — is
 * ambient.
 */
const isInjectedEnv = (
  argument: ts.Expression,
  bindings: ReadonlyMap<string, readonly (ts.Expression | undefined)[]>,
): boolean => {
  const bare = unwrapExpression(argument)
  if (isInertObjectLiteral(bare)) return true
  if (!ts.isIdentifier(bare)) return false
  const bound = bindings.get(bare.text)
  return (
    bound !== undefined &&
    bound.length > 0 &&
    bound.every(
      (initializer) =>
        initializer !== undefined && isInertObjectLiteral(unwrapExpression(initializer)),
    )
  )
}

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

/** Written in a type, which is erased: `typeof capability`, `consumer.CapabilityDecision`. */
const inTypePosition = (node: ts.Node): boolean => {
  for (let at = node.parent; at !== undefined && !ts.isSourceFile(at); at = at.parent) {
    // `class X extends consumer.Base` is a runtime reference; `implements` is not.
    if (ts.isExpressionWithTypeArguments(at)) {
      return !(
        ts.isHeritageClause(at.parent) &&
        at.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        ts.isClassLike(at.parent.parent)
      )
    }
    if (ts.isTypeNode(at)) return true
    if (ts.isStatement(at) || ts.isFunctionLike(at)) return false
  }
  return false
}

/** Declarations and members whose `name` is a name, not a use of a binding. */
const NAMED_DECLARATION: readonly ((node: ts.Node) => boolean)[] = [
  ts.isPropertyAccessExpression,
  ts.isPropertyAssignment,
  ts.isMethodDeclaration,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isMethodSignature,
  ts.isGetAccessorDeclaration,
  ts.isSetAccessorDeclaration,
  ts.isEnumMember,
  ts.isParameter,
  ts.isBindingElement,
  ts.isVariableDeclaration,
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
]

/**
 * A NAME in a declaration or member position, which is not a use of the binding.
 *
 * The first version knew six positions, so an interface field, a parameter, a
 * destructured binding, a `for…of` variable or a type annotation mentioning
 * `capability` was an `indirect-use` — a false red on ordinary code.
 */
const isNamePosition = (node: ts.Identifier): boolean => {
  const parent = node.parent
  return (
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    inTypePosition(node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (NAMED_DECLARATION.some((is) => is(parent)) &&
      (parent as ts.Node & { readonly name?: ts.Node }).name === node)
  )
}

/** Any use of an imported binding other than calling it, or `ns.capability(…)`. */
const isIndirectReference = (node: ts.Identifier, bindings: ConsumerBindings): boolean => {
  if (isNamePosition(node) || shadowed(node, node.text)) return false
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
   * The call reads the campaign's receipt: one argument, or an env the scan cannot
   * prove inert (`isInjectedEnv`). The mechanism's own tests inject an inert
   * literal, and those calls do not consume the campaign receipt.
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
  const variables = variableBindings(source)
  const out: CapabilityCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callsConsumer(node, bindings)) {
      const capabilityId = staticId(node.arguments[0], constants)
      out.push({
        file: input.path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        capabilityId,
        ambient: node.arguments[1] === undefined || !isInjectedEnv(node.arguments[1], variables),
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
