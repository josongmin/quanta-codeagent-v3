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
 * Only the parse can say "a CALL EXPRESSION whose callee is the identifier
 * `capability`, imported from the consumer module, with a single string-literal
 * argument". That is the thing the drift guard is about.
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

/**
 * The local name `capability` is bound to, when this file imports it from the
 * consumer module. `undefined` means the file does not consume the receipt at
 * all, and a `capability(...)` call in it is somebody else's function.
 */
/** The local name a `{ capability as X }` clause binds, if this clause has one. */
const aliasInClause = (bindings: ts.NamedImportBindings): string | undefined => {
  if (!ts.isNamedImports(bindings)) return undefined
  for (const element of bindings.elements) {
    const imported = (element.propertyName ?? element.name).text
    if (imported === "capability") return element.name.text
  }
  return undefined
}

const importsConsumer = (statement: ts.Statement): statement is ts.ImportDeclaration =>
  ts.isImportDeclaration(statement) &&
  ts.isStringLiteral(statement.moduleSpecifier) &&
  statement.moduleSpecifier.text.includes(CAPABILITY_CONSUMER_MODULE)

const importedCapabilityAlias = (source: ts.SourceFile): string | undefined => {
  for (const statement of source.statements) {
    if (!importsConsumer(statement)) continue
    const bindings = statement.importClause?.namedBindings
    const alias = bindings === undefined ? undefined : aliasInClause(bindings)
    if (alias !== undefined) return alias
  }
  return undefined
}

/** Every `capability("<literal>")` call in one file, or [] if it imports none. */
export const capabilityCallsites = (
  input: CapabilityCallsiteInput,
): readonly CapabilityCallsite[] => {
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const alias = importedCapabilityAlias(source)
  if (alias === undefined) return []
  const out: CapabilityCallsite[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === alias &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        out.push({
          file: input.path,
          capabilityId: argument.text,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        })
      }
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return out
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
