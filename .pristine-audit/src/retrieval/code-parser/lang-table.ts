/**
 * Per-language node-type tables (RFC §2.1 / §4.2) — PURE closed tables.
 *
 * Maps file extensions → `ParseLang` (detection), `ParseLang` → grammar
 * `.wasm` basename (loading), and a per-language set of tree-sitter node
 * `type` strings → a `DeclNode.kind`. The walk in `tree-sitter.ts` lifts a
 * node into a `DeclNode` iff its `type` is in the language's decl table.
 *
 * No clock, no randomness, no I/O — just lookup tables.
 */

import type { DeclNode, ParseLang } from "./types"

/** Extension → language. Detection is by extension ONLY (a pure table). An
 *  extension not here ⇒ `no-grammar` ⇒ the caller falls back. */
const EXT_TO_LANG: Readonly<Record<string, ParseLang>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
}

/** `ParseLang` → the grammar `.wasm` basename under the grammar dir
 *  (`tree-sitter-<name>.wasm`). The `tree-sitter-wasms` package names the
 *  TSX grammar `tree-sitter-tsx.wasm`. */
const LANG_TO_WASM: Readonly<Record<ParseLang, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  bash: "tree-sitter-bash.wasm",
}

type Kind = DeclNode["kind"]

/** Tree-sitter node `type` → `DeclNode.kind`, per language. Only the node
 *  types listed here are lifted into the decl tree; everything else is
 *  inter-decl text (attached to the adjacent chunk by the chunker). The
 *  sets mirror the §2.1 enumeration (function / class / method / interface /
 *  lexical_declaration) plus the common per-language analogues. */
const NODE_KINDS: Readonly<Record<ParseLang, Readonly<Record<string, Kind>>>> = {
  typescript: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "const",
    variable_declaration: "const",
    method_definition: "method",
    public_field_definition: "const",
    module: "other",
    internal_module: "other",
  },
  tsx: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "const",
    variable_declaration: "const",
    method_definition: "method",
    public_field_definition: "const",
  },
  javascript: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    lexical_declaration: "const",
    variable_declaration: "const",
    method_definition: "method",
    field_definition: "const",
  },
  python: {
    function_definition: "function",
    class_definition: "class",
    // `decorated_definition` is NOT listed here: it is a WRAPPER (see
    // WRAPPER_KINDS). It spans the `@decorator` lines AND the inner
    // class/function decl; its kind + container-ness are INHERITED from that
    // inner decl so a decorated CLASS surfaces as a container `class` (with its
    // methods as children) and a decorated FUNCTION as `function`, while the
    // decl's line span still covers the decorator lines.
  },
  rust: {
    function_item: "function",
    struct_item: "class",
    enum_item: "enum",
    trait_item: "interface",
    impl_item: "class",
    mod_item: "other",
    type_item: "type",
    const_item: "const",
    static_item: "const",
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
    type_declaration: "type",
    const_declaration: "const",
    var_declaration: "const",
  },
  bash: {
    function_definition: "function",
  },
}

/** Node types whose CHILDREN we descend into to collect nested decls (a class
 *  body's methods, a python class's methods, a rust impl's functions). When a
 *  decl's type is NOT here, it is treated as a leaf (no children walked). */
const CONTAINER_KINDS: Readonly<Record<ParseLang, ReadonlySet<string>>> = {
  typescript: new Set(["class_declaration", "abstract_class_declaration", "module"]),
  tsx: new Set(["class_declaration", "abstract_class_declaration"]),
  javascript: new Set(["class_declaration"]),
  python: new Set(["class_definition"]),
  rust: new Set(["impl_item", "trait_item", "mod_item"]),
  go: new Set([]),
  bash: new Set([]),
}

/** Node types that WRAP a single inner declaration: the wrapper supplies the
 *  outer LINE SPAN (so e.g. python `@decorator` lines stay in the decl's range)
 *  while the inner decl supplies the kind, name and container-ness. The walk in
 *  `tree-sitter.ts` lifts a wrapper into ONE `DeclNode` keyed on the inner decl
 *  but spanned by the wrapper. Distinct from a plain non-decl node (whose
 *  children are merely descended): a wrapper is a decl in its own right.
 *
 *  Python `decorated_definition` is the canonical case. (TS `export_statement`
 *  is deliberately NOT a wrapper — it is descended through as a non-decl, which
 *  keeps the pre-existing "export keyword not in span" behaviour unchanged.) */
const WRAPPER_KINDS: Readonly<Record<ParseLang, ReadonlySet<string>>> = {
  typescript: new Set([]),
  tsx: new Set([]),
  javascript: new Set([]),
  python: new Set(["decorated_definition"]),
  rust: new Set([]),
  go: new Set([]),
  bash: new Set([]),
}

/** Detect the language for `path` by its extension. `null` ⇒ no grammar. */
export const langForPath = (path: string): ParseLang | null => {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const ext = path.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

export const wasmBasename = (lang: ParseLang): string => LANG_TO_WASM[lang]

export const kindForNodeType = (lang: ParseLang, type: string): Kind | undefined =>
  NODE_KINDS[lang][type]

export const isContainer = (lang: ParseLang, type: string): boolean =>
  CONTAINER_KINDS[lang].has(type)

/** True iff `type` wraps a single inner decl (see {@link WRAPPER_KINDS}). The
 *  walk treats it as a decl spanned by the wrapper but kinded by the child. */
export const isWrapper = (lang: ParseLang, type: string): boolean => WRAPPER_KINDS[lang].has(type)
