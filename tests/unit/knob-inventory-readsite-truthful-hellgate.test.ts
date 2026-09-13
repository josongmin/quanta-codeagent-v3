/**
 * KNOB-INVENTORY readSite TRUTHFULNESS ratchet.
 *
 * The completeness ratchet only proves each envKey is read *somewhere*; nothing
 * verified the per-entry `readSite` STRING actually points at a file that reads
 * that key. So stale readSites accumulated silently (jun-15 audit found two:
 * QUANTA_MENTION_SYMBOL → assembler.ts that never reads it, and
 * QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL → driver.ts). `readSite` is the field
 * `/knobs` + discoverability point operators at, so a lie here mis-routes a
 * human debugging "why is this knob on".
 *
 * RULE (exact, count 0): every `readSite` file must exist under src/ and carry
 * AST evidence tied to the knob: a non-comment envKey syntax node, a live call
 * through a key-bearing imported declaration, or the canonical bench schema id
 * passed to the resolver. Comments and bare imports cannot satisfy the guard.
 *
 * NOTE: `readSite` may carry a trailing parenthetical note
 * (e.g. "ci-bot.ts (buildCiBotWiring …)"); we resolve the leading path token.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { KNOB_INVENTORY } from "@/config/knob-inventory"
import { ALL_BENCH_SCHEMAS } from "@/config/knob-schema/schemas"

const SRC = join(import.meta.dir, "..", "..", "src")

interface StaleHit {
  readonly envKey: string
  readonly readSite: string
  readonly reason: "missing-file" | "key-not-present"
}

const sourceCache = new Map<string, ts.SourceFile>()
const benchReadTokenByEnv = new Map(ALL_BENCH_SCHEMAS.map((schema) => [schema.envKey, schema.id]))

const parsedSource = (path: string, source?: string): ts.SourceFile => {
  const cached = sourceCache.get(path)
  if (cached !== undefined) return cached
  const text = source ?? readFileSync(path, "utf8")
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  sourceCache.set(path, file)
  return file
}

const subtreeHasString = (node: ts.Node, value: string): boolean => {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (ts.isStringLiteralLike(child) && child.text === value) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

const subtreeHasKeySyntax = (node: ts.Node, envKey: string): boolean => {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (
      (ts.isPropertyAccessExpression(child) && child.name.text === envKey) ||
      (ts.isElementAccessExpression(child) &&
        child.argumentExpression !== undefined &&
        ts.isStringLiteralLike(child.argumentExpression) &&
        child.argumentExpression.text === envKey) ||
      (ts.isStringLiteralLike(child) && child.text === envKey)
    ) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

const declarationCarriesKey = (
  file: ts.SourceFile,
  exportedName: string,
  envKey: string,
): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exportedName &&
      node.initializer !== undefined &&
      subtreeHasString(node.initializer, envKey)
    ) {
      found = true
      return
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === exportedName &&
      node.body !== undefined &&
      subtreeHasKeySyntax(node.body, envKey)
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const resolveImportedModule = (
  fromPath: string,
  spec: string,
  srcRoot: string,
): string | undefined => {
  const base = spec.startsWith("@/")
    ? join(srcRoot, spec.slice(2))
    : spec.startsWith(".")
      ? join(fromPath, "..", spec)
      : undefined
  if (base === undefined) return undefined
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

interface ExportHop {
  readonly path: string
  readonly name: string
}

const exportDeclarationHops = (
  statement: ts.ExportDeclaration,
  fromPath: string,
  exportedName: string,
  srcRoot: string,
): readonly ExportHop[] => {
  if (statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return []
  }
  const target = resolveImportedModule(fromPath, statement.moduleSpecifier.text, srcRoot)
  if (target === undefined) return []
  if (statement.exportClause === undefined) return [{ path: target, name: exportedName }]
  if (!ts.isNamedExports(statement.exportClause)) return []
  return statement.exportClause.elements
    .filter((element) => element.name.text === exportedName)
    .map((element) => ({
      path: target,
      name: element.propertyName?.text ?? element.name.text,
    }))
}

const moduleExportCarriesKey = (
  path: string,
  exportedName: string,
  envKey: string,
  srcRoot: string,
  visited: ReadonlySet<string> = new Set(),
): boolean => {
  const visitKey = `${path}:${exportedName}`
  if (visited.has(visitKey)) return false
  const nextVisited = new Set(visited).add(visitKey)
  const file = parsedSource(path)
  if (declarationCarriesKey(file, exportedName, envKey)) return true
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    for (const hop of exportDeclarationHops(statement, path, exportedName, srcRoot)) {
      if (moduleExportCarriesKey(hop.path, hop.name, envKey, srcRoot, nextVisited)) return true
    }
  }
  return false
}

const localKeyCarriers = (file: ts.SourceFile, envKey: string): Set<string> => {
  const carriers = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer !== undefined &&
        subtreeHasString(decl.initializer, envKey)
      ) {
        carriers.add(decl.name.text)
      }
    }
  }
  return carriers
}

const addImportedKeyCarriers = (
  carriers: Set<string>,
  file: ts.SourceFile,
  envKey: string,
  sourcePath: string,
  srcRoot: string,
): void => {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const target = resolveImportedModule(sourcePath, statement.moduleSpecifier.text, srcRoot)
    const named = statement.importClause?.namedBindings
    if (target === undefined || named === undefined || !ts.isNamedImports(named)) continue
    const targetFile = parsedSource(target)
    for (const element of named.elements) {
      const exportedName = element.propertyName?.text ?? element.name.text
      if (
        declarationCarriesKey(targetFile, exportedName, envKey) ||
        moduleExportCarriesKey(target, exportedName, envKey, srcRoot)
      ) {
        carriers.add(element.name.text)
      }
    }
  }
}

const rootedInCarrier = (node: ts.Expression, carriers: ReadonlySet<string>): boolean => {
  let current = node
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) && carriers.has(current.text)
}

/** The manifest's row arrays. `PORT_GATED_TOOLS` joined `GATED_TOOLS` when the
 *  `DefaultToolPorts`-gated rows were split into `gated-tools-ports.ts` to keep the data
 *  file under the god-module line; its `env:` descriptors are the same declarations. */
const MANIFEST_ROW_ARRAYS: ReadonlySet<string> = new Set(["GATED_TOOLS", "PORT_GATED_TOOLS"])

const belongsToGatedTools = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      MANIFEST_ROW_ARRAYS.has(current.name.text)
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

const nodeUsesLiveKey = (
  node: ts.Node,
  envKey: string,
  callTokens: ReadonlySet<string>,
  carriers: ReadonlySet<string>,
): boolean => {
  if (ts.isPropertyAccessExpression(node) && node.name.text === envKey) return true
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    const arg = node.argumentExpression
    if (ts.isStringLiteralLike(arg) && arg.text === envKey) return true
    if (rootedInCarrier(arg, carriers)) return true
  }
  if (
    ts.isComputedPropertyName(node) &&
    ts.isIdentifier(node.expression) &&
    carriers.has(node.expression.text)
  ) {
    return true
  }
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "env" &&
    ts.isStringLiteralLike(node.initializer) &&
    node.initializer.text === envKey
  ) {
    return belongsToGatedTools(node)
  }
  if (!ts.isCallExpression(node)) return false
  return node.arguments.some(
    (arg) =>
      (ts.isStringLiteralLike(arg) && callTokens.has(arg.text)) || rootedInCarrier(arg, carriers),
  )
}

const fileHasLiveKeyUse = (
  file: ts.SourceFile,
  envKey: string,
  callTokens: ReadonlySet<string>,
  carriers: ReadonlySet<string>,
): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (nodeUsesLiveKey(node, envKey, callTokens, carriers)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const sourceHasLiveKeyUse = (
  source: string,
  envKey: string,
  sourcePath: string,
  srcRoot: string,
): boolean => {
  const file = parsedSource(sourcePath, source)
  const carriers = localKeyCarriers(file, envKey)
  addImportedKeyCarriers(carriers, file, envKey, sourcePath, srcRoot)
  const callTokens = new Set([envKey])
  const benchToken = benchReadTokenByEnv.get(envKey)
  if (benchToken !== undefined) callTokens.add(benchToken)
  return fileHasLiveKeyUse(file, envKey, callTokens, carriers)
}

/** Pure detector — also reused by the red-on-injection self-test below. */
const findStaleReadSites = (
  entries: ReadonlyArray<{ envKey: string; readSite?: string }>,
  srcRoot: string,
): StaleHit[] => {
  const hits: StaleHit[] = []
  for (const e of entries) {
    if (e.readSite === undefined) continue
    const relPath = e.readSite.split(/[\s(]/)[0] // strip trailing "(note)"
    if (relPath === undefined || relPath.length === 0) continue
    const abs = join(srcRoot, relPath)
    if (!existsSync(abs)) {
      hits.push({ envKey: e.envKey, readSite: e.readSite, reason: "missing-file" })
      continue
    }
    if (!sourceHasLiveKeyUse(readFileSync(abs, "utf8"), e.envKey, abs, srcRoot)) {
      hits.push({ envKey: e.envKey, readSite: e.readSite, reason: "key-not-present" })
    }
  }
  return hits
}

describe("knob-inventory readSite truthfulness", () => {
  test("every readSite file exists and contains live AST evidence for its envKey (0 stale)", () => {
    const stale = findStaleReadSites(KNOB_INVENTORY, SRC)
    if (stale.length > 0) {
      const lines = stale.map((s) => `  ${s.envKey} → ${s.readSite} [${s.reason}]`).join("\n")
      throw new Error(
        `${stale.length} stale readSite(s) in knob-inventory.ts — point readSite at a file ` +
          `with live call/access/descriptor evidence for the key:\n${lines}`,
      )
    }
    expect(stale.length).toBe(0)
  }, 30_000)

  test("DETECTOR has teeth (red-on-injection): a bogus readSite is flagged", () => {
    // missing file
    expect(
      findStaleReadSites([{ envKey: "QUANTA_X", readSite: "does/not/exist.ts" }], SRC),
    ).toHaveLength(1)
    // file exists but does NOT contain the key (knob-inventory.ts itself never
    // reads a fictional key)
    const bogus = findStaleReadSites(
      [{ envKey: "QUANTA_TOTALLY_FAKE_KEY_ZZZ", readSite: "config/knob-inventory.ts" }],
      SRC,
    )
    expect(bogus).toHaveLength(1)
    expect(bogus[0]?.reason).toBe("key-not-present")
  })

  test("DETECTOR accepts a real entry (control)", () => {
    // QUANTA_GITHUB_WEBHOOK is read in apps/cli/webhook-server-setup.ts
    expect(
      findStaleReadSites(
        [{ envKey: "QUANTA_GITHUB_WEBHOOK", readSite: "apps/cli/webhook-server-setup.ts" }],
        SRC,
      ),
    ).toHaveLength(0)
  })

  test("DETECTOR rejects a comment-only envKey mention", () => {
    const root = mkdtempSync(join(tmpdir(), "quanta-readsite-comment-only-"))
    try {
      writeFileSync(
        join(root, "comment-only.ts"),
        "// QUANTA_COMMENT_ONLY is intentionally not read at runtime.\nexport const value = 1\n",
      )
      const stale = findStaleReadSites(
        [{ envKey: "QUANTA_COMMENT_ONLY", readSite: "comment-only.ts" }],
        root,
      )
      expect(stale).toHaveLength(1)
      expect(stale[0]?.reason).toBe("key-not-present")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("DETECTOR rejects a declaration-only key with no live consumer", () => {
    const root = mkdtempSync(join(tmpdir(), "quanta-readsite-declaration-only-"))
    try {
      writeFileSync(join(root, "declared.ts"), 'export const UNUSED_KEY = "QUANTA_DECLARED_ONLY"\n')
      const stale = findStaleReadSites(
        [{ envKey: "QUANTA_DECLARED_ONLY", readSite: "declared.ts" }],
        root,
      )
      expect(stale).toHaveLength(1)
      expect(stale[0]?.reason).toBe("key-not-present")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
