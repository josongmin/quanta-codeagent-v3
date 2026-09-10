/**
 * SEP6 S8 hellgate — every live mention projection uses one shared policy.
 *
 * This guard checks both the value contract and the complete known consumer
 * set. The mutation case proves that deleting one live call makes the checker
 * fail for exactly that consumer instead of passing over an empty scan.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { mentionFirstLine } from "@/shared"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = resolve(import.meta.dir, "../..")

const CONSUMERS = [
  "src/agent/mention-runner/skill-resolver.ts",
  "src/agent/plugin-app-resolver/skill-resolver.ts",
  "src/agent/plugin-app-resolver/plugin-resolver.ts",
  "src/agent/plugin-app-resolver/mcp-resolver.ts",
  "src/agent/plugin-app-resolver/subagent-resolver.ts",
  "src/apps/cli/at-autocomplete/provider.ts",
  "src/host/runtime/internal/mention-source-deps.ts",
] as const

type SourceFacts = {
  readonly callsSharedOwner: boolean
  readonly declaresLegacyOwner: boolean
  readonly declaresLocalProjection: boolean
}

type SharedBindings = {
  readonly named: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
}

const addSharedBindings = (
  bindings: ts.NamedImportBindings | undefined,
  named: Set<string>,
  namespaces: Set<string>,
): void => {
  if (bindings === undefined) return
  if (ts.isNamespaceImport(bindings)) {
    namespaces.add(bindings.name.text)
    return
  }
  for (const element of bindings.elements) {
    if ((element.propertyName ?? element.name).text === "mentionFirstLine") {
      named.add(element.name.text)
    }
  }
}

const sharedBindings = (file: ts.SourceFile): SharedBindings => {
  const named = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (!["@/shared", "@/shared/mention-text"].includes(statement.moduleSpecifier.text)) continue
    addSharedBindings(statement.importClause?.namedBindings, named, namespaces)
  }
  return { named, namespaces }
}

const isLegacyOwner = (node: ts.Node): boolean => {
  if (ts.isFunctionDeclaration(node)) return node.name?.text === "firstLineOf"
  return (
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "firstLineOf"
  )
}

const isFunctionWithBody = (
  node: ts.Node,
): node is (
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
) & { readonly body: ts.ConciseBody } =>
  (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)) &&
  node.body !== undefined

/** Reject a locally-owned newline projection regardless of its identifier.
 * The bounded mention surface has no legitimate reason to split a description
 * line itself: every such projection must route through mentionFirstLine. */
const isLocalProjection = (node: ts.Node, file: ts.SourceFile): boolean => {
  if (!isFunctionWithBody(node)) return false
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      ["indexOf", "search", "split"].includes(child.expression.name.text)
    ) {
      const arg = child.arguments[0]
      if (arg?.getText(file).includes("\\n")) found = true
    }
    ts.forEachChild(child, visit)
  }
  visit(node.body)
  return found
}

const isSharedOwnerCall = (node: ts.Node, bindings: SharedBindings): boolean => {
  if (!ts.isCallExpression(node)) return false
  if (ts.isIdentifier(node.expression)) return bindings.named.has(node.expression.text)
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    bindings.namespaces.has(node.expression.expression.text) &&
    node.expression.name.text === "mentionFirstLine"
  )
}

/** Parse the module so comments, strings, and uncalled imports cannot satisfy
 *  the production-call obligation. Aliased and namespace imports remain legal. */
const inspectSource = (path: string, source: string): SourceFacts => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = sharedBindings(file)
  let callsSharedOwner = false
  let declaresLegacyOwner = false
  let declaresLocalProjection = false
  const visit = (node: ts.Node): void => {
    if (isLegacyOwner(node)) declaresLegacyOwner = true
    if (isLocalProjection(node, file)) declaresLocalProjection = true
    if (isSharedOwnerCall(node, bindings)) callsSharedOwner = true
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { callsSharedOwner, declaresLegacyOwner, declaresLocalProjection }
}

const parityViolations = (sources: ReadonlyMap<string, string>): string[] =>
  CONSUMERS.filter((path) => {
    const facts = inspectSource(path, sources.get(path) ?? "")
    return !facts.callsSharedOwner || facts.declaresLegacyOwner
  })

const productionSources = (): Map<string, string> =>
  new Map(CONSUMERS.map((path) => [path, readFileSync(resolve(REPO_ROOT, path), "utf8")]))

const projectionSurfaceSources = (): Map<string, string> => {
  const srcRoot = resolve(REPO_ROOT, "src")
  const mentionRunnerRoot = resolve(srcRoot, "agent/mention-runner")
  const pluginResolverRoot = resolve(srcRoot, "agent/plugin-app-resolver")
  const mentionRunnerResolvers = [
    ...new Bun.Glob("*resolver.ts").scanSync({ cwd: mentionRunnerRoot }),
  ].sort()
  const pluginResolvers = [
    ...new Bun.Glob("*resolver.ts").scanSync({ cwd: pluginResolverRoot }),
  ].sort()
  assertScanPopulation(
    mentionRunnerResolvers.map((path) => resolve(mentionRunnerRoot, path)),
    mentionRunnerRoot,
    {
      id: "tests/unit/mention-first-line-parity-hellgate.test.ts#MENTION-RUNNER",
      collectable: (name) => name.endsWith("resolver.ts"),
      topLevelOnly: true,
    },
  )
  assertScanPopulation(
    pluginResolvers.map((path) => resolve(pluginResolverRoot, path)),
    pluginResolverRoot,
    {
      id: "tests/unit/mention-first-line-parity-hellgate.test.ts#PLUGIN-APP-RESOLVER",
      collectable: (name) => name.endsWith("resolver.ts"),
      topLevelOnly: true,
    },
  )
  const paths = [
    ...mentionRunnerResolvers.map((path) => `src/agent/mention-runner/${path}`),
    ...pluginResolvers.map((path) => `src/agent/plugin-app-resolver/${path}`),
    "src/apps/cli/at-autocomplete/provider.ts",
    "src/host/runtime/internal/mention-source-deps.ts",
  ].sort()
  return new Map(paths.map((path) => [path, readFileSync(resolve(REPO_ROOT, path), "utf8")]))
}

const localProjectionViolations = (sources: ReadonlyMap<string, string>): string[] =>
  [...sources]
    .filter(([path, source]) => inspectSource(path, source).declaresLocalProjection)
    .map(([path]) => path)
    .sort()

const discoverProductionConsumers = (): string[] => {
  const srcRoot = resolve(REPO_ROOT, "src")
  const glob = new Bun.Glob("**/*.ts")
  const scanned = [...glob.scanSync({ cwd: srcRoot })].map((path) => `src/${path}`).sort()
  const consumers = scanned
    .filter((path) => {
      const source = readFileSync(resolve(REPO_ROOT, path), "utf8")
      if (!source.includes("mentionFirstLine")) return false
      return inspectSource(path, source).callsSharedOwner
    })
    .sort()
  assertScanPopulation(
    scanned.map((path) => resolve(REPO_ROOT, path)),
    srcRoot,
    {
      id: "tests/unit/mention-first-line-parity-hellgate.test.ts#SRC-CONSUMERS",
      collectable: (name) => name.endsWith(".ts"),
      matched: consumers.map((path) => resolve(REPO_ROOT, path)),
    },
  )
  return consumers
}

// Both are immutable source snapshots for this process. Re-reading and reparsing
// the full source tree in each assertion made the ratchet's cost scale with the
// number of mutation controls rather than with the guarded surface.
const PROJECTION_SURFACE_SOURCES = projectionSurfaceSources()
const DISCOVERED_PRODUCTION_CONSUMERS = discoverProductionConsumers()

describe("SEP6 S8 canonical mention first-line policy", () => {
  test.each([
    ["plain", "plain"],
    ["  padded  ", "padded"],
    ["first\nsecond", "first"],
    ["  first  \r\nsecond", "first"],
    ["\r\nsecond", ""],
    ["   ", ""],
    ["", ""],
    [undefined, ""],
  ] as const)("projects %p to %p", (input, expected) => {
    expect(mentionFirstLine(input)).toBe(expected)
  })

  test("all seven live consumers call the shared owner and retain no local owner", () => {
    expect(CONSUMERS).toHaveLength(7)
    expect(new Set(CONSUMERS).size).toBe(7)
    expect(parityViolations(productionSources())).toEqual([])
    expect(DISCOVERED_PRODUCTION_CONSUMERS).toEqual([...CONSUMERS].sort())
    expect(PROJECTION_SURFACE_SOURCES.size).toBeGreaterThanOrEqual(14)
    expect(localProjectionViolations(PROJECTION_SURFACE_SOURCES)).toEqual([])
  })

  test("red-on-injection: deleting one live shared call identifies exactly that consumer", () => {
    const sources = productionSources()
    const victim = CONSUMERS[3]
    const original = sources.get(victim)
    expect(original).toBeDefined()
    sources.set(victim, (original as string).replace(/\bmentionFirstLine\s*\(/, "legacyFirstLine("))

    expect(parityViolations(sources)).toEqual([victim])
  })

  test("red-on-injection: a comment-only fake call cannot hide a removed live call", () => {
    const sources = productionSources()
    const victim = CONSUMERS[0]
    const original = sources.get(victim)
    expect(original).toBeDefined()
    sources.set(
      victim,
      `${(original as string).replace(/\bmentionFirstLine\s*\(/, "legacyFirstLine(")}\n// mentionFirstLine(fake)`,
    )

    expect(parityViolations(sources)).toEqual([victim])
  })

  test("red-on-injection: an eighth local projection owner is rejected regardless of its name", () => {
    const sources = new Map(PROJECTION_SURFACE_SOURCES)
    const victim = "src/agent/plugin-app-resolver/new-kind-resolver.ts"
    sources.set(
      victim,
      'const arbitraryProjection = (text: string) => text.split("\\n")[0]?.trim() ?? ""',
    )

    expect(localProjectionViolations(sources)).toEqual([victim])
  })
})
