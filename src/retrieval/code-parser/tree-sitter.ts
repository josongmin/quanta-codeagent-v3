/**
 * `web-tree-sitter` (WASM) implementation of {@link CodeParserPort} +
 * the `fakeParser` test seam (RFC §4.2).
 *
 * WASM is loaded LAZILY and behind this module:
 *   - `Parser.init()` runs once, on the FIRST parse of ANY language;
 *   - a grammar `.wasm` (`tree-sitter-<lang>.wasm`) loads once per language,
 *     on the first parse of a file with that extension (a `Map` cache).
 * A session that never parses Rust never loads the Rust grammar; a session
 * that never opts in (the default-OFF knobs) never constructs the parser at
 * all, so it pays ZERO WASM cost.
 *
 * NO-THROW: any failure (init / grammar load / parse error / unknown
 * extension) is surfaced as a typed `{ ok:false }` outcome. Determinism: a
 * pinned grammar `.wasm` + a deterministic pre-order traversal ⇒ same input
 * ⇒ byte-identical `ParsedFile`. No `Date.now`, no `Math.random`.
 */

import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { runtimeConfig } from "@/shared"
import { isContainer, kindForNodeType, langForPath, wasmBasename } from "./lang-table"
import type { CodeParserPort, DeclNode, ParsedFile, ParseLang, ParseOutcome } from "./types"

/** Resolve the directory holding the grammar `.wasm` files. Operator override
 *  (`QUANTA_TREE_SITTER_DIR`) wins; otherwise resolve the installed
 *  `@vscode/tree-sitter-wasm/wasm` dir relative to its package. Pure-ish (one
 *  require resolution, no clock/random).
 *
 *  Grammar source = `@vscode/tree-sitter-wasm`: its `.wasm` grammars are built
 *  against tree-sitter ≥0.25 (the emscripten dylink format `web-tree-sitter`
 *  0.26 requires). `tree-sitter-wasms@0.1.x` ships ~0.20-era grammars whose
 *  older dylink format `web-tree-sitter` 0.26 rejects — verified incompatible,
 *  hence the VSCode-bundled set. Same `tree-sitter-<lang>.wasm` basename. */
const resolveGrammarDir = (): string => {
  const override = runtimeConfig().treeSitterDir
  if (override !== undefined) return override
  const req = createRequire(import.meta.url)
  const pkgJson = req.resolve("@vscode/tree-sitter-wasm/package.json")
  return join(pkgJson, "..", "wasm")
}

// Minimal structural shapes of the `web-tree-sitter` classes we touch. We
// avoid importing the concrete types at module load so a missing/odd build
// never breaks type-checking of consumers; the runtime import is dynamic.
interface TsPoint {
  readonly row: number
  readonly column: number
}
interface TsNode {
  readonly type: string
  readonly startPosition: TsPoint
  readonly endPosition: TsPoint
  readonly hasError: boolean
  readonly namedChildren: readonly (TsNode | null)[]
  childForFieldName(name: string): TsNode | null
}
interface TsTree {
  readonly rootNode: TsNode
  delete(): void
}
interface TsParser {
  setLanguage(lang: unknown): unknown
  parse(text: string): TsTree | null
  delete(): void
}

/** Best-effort name extraction: the `name` field if the grammar exposes one,
 *  else empty string. Never throws. */
const nodeName = (node: TsNode): string => {
  const id = node.childForFieldName("name")
  if (id === null) return ""
  // `text` is on the concrete Node; guard structurally.
  const t = (id as unknown as { text?: unknown }).text
  return typeof t === "string" ? t : ""
}

/** Walk a node's named children, lifting decl-typed nodes into `DeclNode`s.
 *  Pre-order, source order. Recurses into container nodes (class/impl bodies)
 *  to collect nested decls. Deterministic. */
const collectDecls = (lang: ParseLang, parent: TsNode): DeclNode[] => {
  const out: DeclNode[] = []
  for (const child of parent.namedChildren) {
    if (child === null) continue
    const kind = kindForNodeType(lang, child.type)
    if (kind === undefined) {
      // Not a decl itself, but it may CONTAIN decls (e.g. an `export_statement`
      // wrapping a class, or a python `decorated_definition`). Descend so a
      // wrapped declaration is not lost.
      const nested = collectDecls(lang, child)
      for (const n of nested) out.push(n)
      continue
    }
    const startLine = child.startPosition.row + 1
    const endLine = child.endPosition.row + 1
    const children = isContainer(lang, child.type) ? collectDeclsInBody(lang, child) : []
    // signatureEndLine: the line before the first child's start, else the
    // start line itself (a leaf decl has a 1-line header for outline purposes;
    // the body, if any, is everything after).
    const firstChild = children[0]
    const signatureEndLine =
      firstChild !== undefined ? Math.max(startLine, firstChild.startLine - 1) : startLine
    out.push({
      kind,
      name: nodeName(child),
      startLine,
      endLine,
      signatureEndLine,
      children,
    })
  }
  return out
}

/** For a container node (class/impl/trait/module), find its body child and
 *  collect the decls inside it. Falls back to scanning the container's own
 *  named children when no obvious body field exists. */
const collectDeclsInBody = (lang: ParseLang, container: TsNode): DeclNode[] => {
  const body = container.childForFieldName("body")
  if (body !== null) return collectDecls(lang, body)
  return collectDecls(lang, container)
}

/** Lazy singletons. `initPromise` runs `Parser.init()` once; `grammars`
 *  caches one `Language` per lang. Module-level cache is fine — it is keyed by
 *  immutable grammar bytes, NOT by any per-run state. */
let initPromise: Promise<unknown> | undefined
const grammars = new Map<ParseLang, Promise<unknown>>()
let ParserClass: { init(): Promise<void>; new (): TsParser } | undefined
let LanguageClass: { load(bytes: Uint8Array): Promise<unknown> } | undefined

const ensureInit = async (): Promise<void> => {
  if (initPromise === undefined) {
    initPromise = (async () => {
      const mod = (await import("web-tree-sitter")) as unknown as {
        Parser: { init(): Promise<void>; new (): TsParser }
        Language: { load(bytes: Uint8Array): Promise<unknown> }
      }
      ParserClass = mod.Parser
      LanguageClass = mod.Language
      await mod.Parser.init()
    })()
  }
  await initPromise
}

const loadGrammar = async (lang: ParseLang): Promise<unknown> => {
  const cached = grammars.get(lang)
  if (cached !== undefined) return cached
  const p = (async () => {
    const bytes = await readFile(join(resolveGrammarDir(), wasmBasename(lang)))
    // `Language.load` accepts a Uint8Array of the grammar wasm.
    if (LanguageClass === undefined) throw new Error("web-tree-sitter not initialised")
    return LanguageClass.load(new Uint8Array(bytes))
  })()
  grammars.set(lang, p)
  return p
}

/** Build the real `web-tree-sitter`-backed parser. NO WASM is touched until
 *  the first `parse()` call — construction is free. */
export const createTreeSitterParser = (): CodeParserPort => ({
  async parse(path: string, text: string): Promise<ParseOutcome> {
    const lang = langForPath(path)
    if (lang === null) return { ok: false, reason: "no-grammar" }
    try {
      await ensureInit()
      const grammar = await loadGrammar(lang)
      if (ParserClass === undefined) return { ok: false, reason: "parse-error" }
      const parser = new ParserClass()
      try {
        parser.setLanguage(grammar)
        const tree = parser.parse(text)
        if (tree === null) return { ok: false, reason: "parse-error" }
        try {
          // A root-level ERROR means the grammar could not parse the file
          // (newer language feature, truncated file). Fall back, NO-THROW.
          if (tree.rootNode.hasError) return { ok: false, reason: "parse-error" }
          const parsed: ParsedFile = {
            lang,
            decls: collectDecls(lang, tree.rootNode),
          }
          return { ok: true, parsed }
        } finally {
          tree.delete()
        }
      } finally {
        parser.delete()
      }
    } catch {
      // ANY failure (init, grammar read, setLanguage version mismatch) ⇒
      // typed fallback. The boundary NEVER throws.
      return { ok: false, reason: "parse-error" }
    }
  },
})

/** Test seam: a `CodeParserPort` that returns canned outcomes from a table
 *  keyed by an exact `text` match — unit tests for the chunker + outline
 *  drive it with hand-built `ParsedFile`s and NEVER touch real WASM. A
 *  `calls` counter lets a test assert the parser was (not) consulted. */
export interface FakeParser extends CodeParserPort {
  /** Number of times `parse` was invoked (assert == 0 for default-OFF). */
  readonly calls: () => number
}

export const fakeParser = (table: ReadonlyMap<string, ParseOutcome>): FakeParser => {
  let n = 0
  return {
    calls: () => n,
    async parse(_path: string, text: string): Promise<ParseOutcome> {
      n += 1
      return table.get(text) ?? { ok: false, reason: "no-grammar" }
    },
  }
}
