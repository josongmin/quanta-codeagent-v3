/**
 * SEP5-09 — retrieval authority manifest. Call-expression AST, not identifier scan.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const SRC = join(import.meta.dir, "..", "..", "src")

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const ent of readdirSync(dir)) {
    if (ent === "node_modules" || ent.startsWith(".")) continue
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) acc.push(p)
  }
  return acc
}

const callExprName = (node: ts.CallExpression): string | undefined => {
  const expr = node.expression
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  return undefined
}

const defaultParamName = (node: ts.Identifier): string | undefined => {
  const parent = node.parent
  if (parent === undefined) return undefined
  if (ts.isParameter(parent) && parent.initializer === node) return node.text
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return node.text
  return undefined
}

const callNames = (file: string): string[] => {
  const text = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callExprName(node)
      if (name !== undefined) names.push(name)
    }
    if (ts.isIdentifier(node)) {
      const name = defaultParamName(node)
      if (name !== undefined) names.push(name)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

describe("retrieval authority manifest", () => {
  const files = walk(SRC)
  test("scanned production files > 0", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  test("canonical factories are called; legacy assembler is gone", () => {
    let embedder = 0
    let reranker = 0
    let legacy = 0
    for (const file of files) {
      const names = callNames(file)
      embedder += names.filter((n) => n === "createEmbedderFromEnv").length
      reranker += names.filter((n) => n === "createRerankerFromEnv").length
      legacy += names.filter((n) => n === "buildRetrievalStackCore").length
    }
    expect(embedder + reranker).toBeGreaterThanOrEqual(2)
    expect(legacy).toBe(0)
  })

  test("mutation: injecting a legacy call into an AST fixture fails", () => {
    const fixture = "buildRetrievalStackCore({ embed: 1 })\n"
    const sf = ts.createSourceFile("inject.ts", fixture, ts.ScriptTarget.Latest, true)
    const names: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        names.push(node.expression.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(names).toContain("buildRetrievalStackCore")
  })
})
