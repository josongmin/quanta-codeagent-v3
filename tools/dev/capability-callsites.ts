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
      const argument = node.arguments[0]
      const capabilityId =
        argument === undefined
          ? undefined
          : ts.isStringLiteralLike(argument)
            ? argument.text
            : ts.isIdentifier(argument)
              ? constants.get(argument.text)
              : undefined
      out.push({
        file: input.path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        capabilityId,
        ambient: node.arguments.length === 1,
        moduleScope: !insideFunction(node),
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

export type CapabilityCallProblem = "unresolved-id" | "ambient-call-inside-a-function"

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
export const capabilityCallProblems = (
  inputs: readonly CapabilityCallsiteInput[],
): readonly string[] =>
  inputs
    .flatMap((input) => capabilityCalls(input))
    .flatMap((call) => {
      if (!call.ambient) return []
      const problems: CapabilityCallProblem[] = []
      if (call.capabilityId === undefined) problems.push("unresolved-id")
      if (!call.moduleScope) problems.push("ambient-call-inside-a-function")
      return problems.map((problem) => `${call.file}:${call.line} ${problem}`)
    })
    .sort()

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
