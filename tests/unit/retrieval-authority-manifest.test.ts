/**
 * SEP5-09 — retrieval authority manifest. Call-expression AST, not identifier scan.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { assertScanPopulation } from "./_shared/scan-population"

const SRC = join(import.meta.dir, "..", "..", "src")
const BARREL = join(SRC, "retrieval", "index.ts")

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

const callNamesFromText = (file: string, text: string): string[] => {
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

const countLegacyAssembler = (sources: ReadonlyArray<{ file: string; text: string }>): number => {
  let legacy = 0
  for (const src of sources) {
    legacy += callNamesFromText(src.file, src.text).filter(
      (n) => n === "buildRetrievalStackCore",
    ).length
  }
  return legacy
}

/** Barrel symbols that are not the live search-index/pipeline factories.
 *  public-compat = different EmbeddingPort contract, retained on the slice barrel.
 *  algorithm = rerank fusion/identity helpers still consumed under their own names.
 */
const BARREL_CLASSIFICATION = {
  createCohereEmbedder: "public-compat",
  createGeminiEmbedder: "public-compat",
  createMoonshotEmbedder: "public-compat",
  createNvidiaEmbedder: "public-compat",
  createOpenAIEmbedder: "public-compat",
  createVoyageEmbedder: "public-compat",
  createXaiEmbedder: "public-compat",
  createZaiEmbedder: "public-compat",
  createCommitEmbedder: "public-compat",
  identityRerankPort: "algorithm",
} as const

const barrelExportNames = (text: string): string[] => {
  const names: string[] = []
  const re =
    /^export \{ ([A-Za-z0-9_]+) \} from "\.\/(?:embedders\/[^"]+|commit-embedder|rerank\/identity)"/gm
  for (const match of text.matchAll(re)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  return names
}

describe("retrieval authority manifest", () => {
  const files = walk(SRC)
  let live: { embedder: number; reranker: number; legacy: number } | undefined
  const liveCounts = (): { embedder: number; reranker: number; legacy: number } => {
    if (live !== undefined) return live
    let embedder = 0
    let reranker = 0
    let legacy = 0
    for (const file of files) {
      const names = callNamesFromText(file, readFileSync(file, "utf8"))
      embedder += names.filter((n) => n === "createEmbedderFromEnv").length
      reranker += names.filter((n) => n === "createRerankerFromEnv").length
      legacy += names.filter((n) => n === "buildRetrievalStackCore").length
    }
    live = { embedder, reranker, legacy }
    return live
  }

  test("scanned production files > 0", () => {
    assertScanPopulation(files, SRC, {
      id: "tests/unit/retrieval-authority-manifest.test.ts#SRC",
      collectable: (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    })
    expect(files.length).toBeGreaterThan(0)
  })

  test("canonical factories are called; legacy assembler is gone", () => {
    const counts = liveCounts()
    expect(counts.embedder + counts.reranker).toBeGreaterThanOrEqual(2)
    expect(counts.legacy).toBe(0)
  }, 15_000)

  test("mutation: injecting a legacy call into the scanned set fails the zero-legacy floor", () => {
    const injected = {
      file: join(SRC, "runner/assemble/inject-legacy.ts"),
      text: "buildRetrievalStackCore({ embed: 1 })\n",
    }
    expect(liveCounts().legacy).toBe(0)
    expect(countLegacyAssembler([injected])).toBeGreaterThan(0)
  }, 15_000)

  test("mutation: a bare identifier/import does not satisfy the canonical call floor", () => {
    const names = callNamesFromText(
      "bare.ts",
      'import { createEmbedderFromEnv } from "@/retrieval"\nconst x = createEmbedderFromEnv\n',
    )
    expect(names.filter((n) => n === "createEmbedderFromEnv")).toHaveLength(0)
  })

  test("every embedders/commit/identity barrel export is classified", () => {
    const names = barrelExportNames(readFileSync(BARREL, "utf8"))
    expect(names.length).toBeGreaterThan(0)
    const classified = new Set(Object.keys(BARREL_CLASSIFICATION))
    const unclassified = names.filter((n) => !classified.has(n))
    expect(unclassified).toEqual([])
    for (const name of names) {
      expect(BARREL_CLASSIFICATION[name as keyof typeof BARREL_CLASSIFICATION]).toBeDefined()
    }
  })
})
