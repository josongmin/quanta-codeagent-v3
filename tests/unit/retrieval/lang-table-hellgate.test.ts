/**
 * HELLGATE — `src/retrieval/code-parser/lang-table.ts` PURE closed tables
 * (RFC jun-6 §2.1 / §4.2).
 *
 * Round-1 gap: the per-language node-type → kind tables, the extension →
 * language detection, the container set, and the wasm basename map are pure
 * lookup tables that NOTHING exercised in isolation. A silent typo in a
 * node-type string (e.g. `struct_item` → `struc_item`) would make the walk in
 * `tree-sitter.ts` drop that declaration class entirely, with no test to
 * catch it. These cases LOCK the exact strings.
 *
 * Drives only the PURE exported functions (`langForPath`, `kindForNodeType`,
 * `isContainer`, `wasmBasename`) with synthetic inputs — no real grammar, no
 * WASM, no I/O.
 */

import { describe, expect, test } from "bun:test"
import {
  isContainer,
  kindForNodeType,
  langForPath,
  type ParseLang,
  wasmBasename,
} from "@/retrieval/code-parser"

describe("lang-table — langForPath (extension detection)", () => {
  const cases: ReadonlyArray<[string, ParseLang | null]> = [
    // TypeScript family.
    ["src/foo.ts", "typescript"],
    ["src/foo.mts", "typescript"],
    ["src/foo.cts", "typescript"],
    ["src/foo.tsx", "tsx"],
    // JavaScript family (all collapse to "javascript").
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
    // Other languages.
    ["mod.py", "python"],
    ["types.pyi", "python"],
    ["lib.rs", "rust"],
    ["main.go", "go"],
    ["script.sh", "bash"],
    ["script.bash", "bash"],
    // Unknown extension ⇒ null ⇒ caller falls back.
    ["readme.md", null],
    ["data.json", null],
    ["image.png", null],
    // No extension ⇒ null.
    ["Makefile", null],
    ["LICENSE", null],
    [".gitignore", "bash"], // ".gitignore" → ext "gitignore"? no — see below
  ]

  // ".gitignore": lastIndexOf(".") is index 0, ext = "gitignore" → unknown → null.
  test.each(cases.filter(([p]) => p !== ".gitignore"))(
    "%s ⇒ %s",
    (path, expected) => {
      expect(langForPath(path)).toBe(expected)
    },
  )

  test("dotfile with no real extension (.gitignore) ⇒ null (ext 'gitignore' unknown)", () => {
    expect(langForPath(".gitignore")).toBeNull()
  })

  test("extension match is case-insensitive (.TS ⇒ typescript)", () => {
    expect(langForPath("FOO.TS")).toBe("typescript")
    expect(langForPath("Foo.Tsx")).toBe("tsx")
    expect(langForPath("M.PY")).toBe("python")
  })

  test("trailing dot ⇒ empty ext ⇒ null", () => {
    expect(langForPath("foo.")).toBeNull()
  })

  test("path with directory dots resolves on the LAST dot only", () => {
    expect(langForPath("a.b.c/d.e.ts")).toBe("typescript")
    expect(langForPath("my.module.dir/file.rs")).toBe("rust")
  })

  test("empty string ⇒ null", () => {
    expect(langForPath("")).toBeNull()
  })
})

describe("lang-table — kindForNodeType (node-type → DeclNode.kind)", () => {
  // The point: lock the EXACT node-type strings so a typo that silently drops a
  // decl class fails here.
  const cases: ReadonlyArray<[ParseLang, string, string | undefined]> = [
    // TypeScript.
    ["typescript", "function_declaration", "function"],
    ["typescript", "generator_function_declaration", "function"],
    ["typescript", "class_declaration", "class"],
    ["typescript", "abstract_class_declaration", "class"],
    ["typescript", "interface_declaration", "interface"],
    ["typescript", "type_alias_declaration", "type"],
    ["typescript", "enum_declaration", "enum"],
    ["typescript", "lexical_declaration", "const"],
    ["typescript", "variable_declaration", "const"],
    ["typescript", "method_definition", "method"],
    ["typescript", "public_field_definition", "const"],
    ["typescript", "module", "other"],
    ["typescript", "internal_module", "other"],
    ["typescript", "not_a_node_type", undefined],
    // tsx (no module/internal_module).
    ["tsx", "function_declaration", "function"],
    ["tsx", "class_declaration", "class"],
    ["tsx", "method_definition", "method"],
    ["tsx", "type_alias_declaration", "type"],
    ["tsx", "module", undefined], // tsx table omits module
    // JavaScript (field_definition, NOT public_field_definition).
    ["javascript", "function_declaration", "function"],
    ["javascript", "class_declaration", "class"],
    ["javascript", "method_definition", "method"],
    ["javascript", "field_definition", "const"],
    ["javascript", "lexical_declaration", "const"],
    ["javascript", "public_field_definition", undefined], // not in js table
    ["javascript", "interface_declaration", undefined], // js has no interfaces
    // Python.
    ["python", "function_definition", "function"],
    ["python", "class_definition", "class"],
    ["python", "decorated_definition", "function"],
    ["python", "function_declaration", undefined], // py uses _definition
    // Rust.
    ["rust", "function_item", "function"],
    ["rust", "struct_item", "class"],
    ["rust", "enum_item", "enum"],
    ["rust", "trait_item", "interface"],
    ["rust", "impl_item", "class"],
    ["rust", "mod_item", "other"],
    ["rust", "type_item", "type"],
    ["rust", "const_item", "const"],
    ["rust", "static_item", "const"],
    ["rust", "struc_item", undefined], // typo guard
    // Go.
    ["go", "function_declaration", "function"],
    ["go", "method_declaration", "method"],
    ["go", "type_declaration", "type"],
    ["go", "const_declaration", "const"],
    ["go", "var_declaration", "const"],
    ["go", "struct_item", undefined], // rust string must not leak into go
    // Bash.
    ["bash", "function_definition", "function"],
    ["bash", "class_declaration", undefined],
  ]

  test.each(cases)("%s / %s ⇒ %s", (lang, type, expected) => {
    expect(kindForNodeType(lang, type)).toBe(expected as never)
  })
})

describe("lang-table — isContainer (descend-into-children set)", () => {
  const cases: ReadonlyArray<[ParseLang, string, boolean]> = [
    // TypeScript containers.
    ["typescript", "class_declaration", true],
    ["typescript", "abstract_class_declaration", true],
    ["typescript", "module", true],
    ["typescript", "interface_declaration", false], // not a container
    ["typescript", "function_declaration", false],
    // tsx (no module container).
    ["tsx", "class_declaration", true],
    ["tsx", "abstract_class_declaration", true],
    ["tsx", "module", false],
    // JavaScript.
    ["javascript", "class_declaration", true],
    ["javascript", "abstract_class_declaration", false], // js has no abstract
    // Python.
    ["python", "class_definition", true],
    ["python", "function_definition", false],
    // Rust.
    ["rust", "impl_item", true],
    ["rust", "trait_item", true],
    ["rust", "mod_item", true],
    ["rust", "struct_item", false], // struct is a LEAF — its fields are not decls
    ["rust", "function_item", false],
    // Go + bash have EMPTY container sets.
    ["go", "function_declaration", false],
    ["go", "method_declaration", false],
    ["bash", "function_definition", false],
  ]

  test.each(cases)("%s / %s ⇒ container=%s", (lang, type, expected) => {
    expect(isContainer(lang, type)).toBe(expected)
  })
})

describe("lang-table — wasmBasename (grammar file map)", () => {
  const cases: ReadonlyArray<[ParseLang, string]> = [
    ["typescript", "tree-sitter-typescript.wasm"],
    ["tsx", "tree-sitter-tsx.wasm"],
    ["javascript", "tree-sitter-javascript.wasm"],
    ["python", "tree-sitter-python.wasm"],
    ["rust", "tree-sitter-rust.wasm"],
    ["go", "tree-sitter-go.wasm"],
    ["bash", "tree-sitter-bash.wasm"],
  ]

  test.each(cases)("%s ⇒ %s", (lang, expected) => {
    expect(wasmBasename(lang)).toBe(expected)
  })

  test("every ParseLang has a distinct .wasm basename", () => {
    const langs: ParseLang[] = ["typescript", "tsx", "javascript", "python", "rust", "go", "bash"]
    const names = langs.map((l) => wasmBasename(l))
    expect(new Set(names).size).toBe(langs.length)
    for (const n of names) expect(n.endsWith(".wasm")).toBe(true)
  })
})

describe("lang-table — cross-table consistency", () => {
  const langs: ParseLang[] = ["typescript", "tsx", "javascript", "python", "rust", "go", "bash"]

  test("every container node-type is also a known decl node-type for its language", () => {
    // A container must be liftable (have a kind) — otherwise the walk would
    // descend into a node it never emits, silently losing the wrapper decl.
    const containerProbes: ReadonlyArray<[ParseLang, string]> = [
      ["typescript", "class_declaration"],
      ["typescript", "abstract_class_declaration"],
      ["typescript", "module"],
      ["tsx", "class_declaration"],
      ["javascript", "class_declaration"],
      ["python", "class_definition"],
      ["rust", "impl_item"],
      ["rust", "trait_item"],
      ["rust", "mod_item"],
    ]
    for (const [lang, type] of containerProbes) {
      expect(isContainer(lang, type)).toBe(true)
      expect(kindForNodeType(lang, type)).toBeDefined()
    }
  })

  test("langForPath never returns a ParseLang without a wasm basename", () => {
    // Detection and grammar-loading tables must agree on the language set.
    const exts = ["ts", "mts", "cts", "tsx", "js", "py", "rs", "go", "sh"]
    for (const ext of exts) {
      const lang = langForPath(`x.${ext}`)
      expect(lang).not.toBeNull()
      if (lang !== null) expect(wasmBasename(lang)).toMatch(/^tree-sitter-.+\.wasm$/)
    }
    void langs
  })
})
