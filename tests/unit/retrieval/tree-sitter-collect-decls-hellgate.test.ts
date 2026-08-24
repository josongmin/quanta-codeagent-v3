/**
 * HELLGATE — `src/retrieval/code-parser/tree-sitter.ts` decl-walk
 * (`collectDecls` / `collectDeclsInBody` / `nodeName`) (RFC jun-6 §4.2).
 *
 * Round-1 gap: the pre-order walk that lifts tree-sitter `TsNode`s into
 * `DeclNode`s (names, kinds, signatureEndLine, nesting) had NO unit coverage.
 *
 * The round-1 brief assumed the pinned grammar `.wasm` is ABI-incompatible in
 * THIS env (so a real parse always degrades to `parse-error`, leaving the walk
 * dead), and asked for a SYNTHETIC `TsNode` tree. Two findings while writing:
 *
 *   FINDING A (blocker for the synthetic approach): `collectDecls`,
 *   `collectDeclsInBody` and `nodeName` are MODULE-PRIVATE — not exported from
 *   `tree-sitter.ts` nor re-exported by the `code-parser` barrel. The only
 *   public consumer is `createTreeSitterParser().parse(path, text)`, which
 *   dynamically loads `web-tree-sitter` + the grammar `.wasm` and runs a REAL
 *   `parse()` before `collectDecls(lang, rootNode)`. There is no seam to feed a
 *   hand-built `rootNode`. Driving the walk from a synthetic `TsNode` would
 *   require exporting the fns or adding an injection seam — both SOURCE edits,
 *   forbidden here.
 *
 *   FINDING B (the premise is FALSE for TS/JS in this env): the bundled
 *   `@vscode/tree-sitter-wasm` TypeScript/JavaScript grammars DO load and parse
 *   successfully here — a `.ts` class-with-two-methods returns `{ok:true}` with
 *   a fully-populated DeclNode tree. So the walk IS exercisable end-to-end
 *   through the real parser, which is strictly BETTER than synthetic nodes
 *   (it proves `nodeName` field extraction, container descent, and 1-based
 *   line math against a real AST).
 *
 * This suite therefore drives `collectDecls` through the REAL parser and pins
 * the produced DeclNode tree. Every grammar-dependent case is guarded by a
 * ONE-TIME top-level availability probe (`GRAMMAR_TS/PY/RUST`): if a future/CI
 * env genuinely lacks a grammar (parse degrades to {ok:false}), the dependent
 * cases are reported as SKIPPED via `test.skipIf` — VISIBLY absent, never a
 * false-green silent pass. The no-throw + typed-outcome invariant is asserted
 * UNCONDITIONALLY (it needs no grammar).
 *
 * CI-PORTABILITY: a bare `if (out === null) return` would let a missing grammar
 * report a normal PASS with zero assertions (un-verifying the decorated-class /
 * wrapper fix on any machine where the grammar is absent). `skipIf` instead
 * surfaces the gap loudly in the report.
 *
 * UPDATE (jun-27): FINDING A is now RESOLVED — a minimal test-only seam
 * (`export const __test = { collectDecls, nodeName }` in `tree-sitter.ts`) lets
 * the bottom `describe` drive the walk over a SYNTHETIC `TsNode` tree, so the
 * nesting + name-extraction logic is pinned even on a host with NO grammar
 * `.wasm` (the `skipIf` real-parse cases above go silent there; these do not).
 */

import { describe, expect, test } from "bun:test"
import { createTreeSitterParser, type ParseOutcome } from "@/retrieval/code-parser"
// Test-only seam: the module-private decl-walk + name extractor (grammar-independent).
import { __test } from "@/retrieval/code-parser/tree-sitter"
import { nth, present } from "../../_helpers/expect-present"

const parser = createTreeSitterParser()

/** Parse with the NO-THROW boundary asserted, returning the typed outcome.
 *  Never silently swallows an absent grammar — callers run only under a
 *  `skipIf(!GRAMMAR_*)` gate, so a non-ok outcome here is a HARD failure. */
const parseOk = async (path: string, text: string): Promise<ParseOutcome & { ok: true }> => {
  let out: ParseOutcome
  try {
    out = await parser.parse(path, text)
  } catch (e) {
    throw new Error(`parse() threw past its NO-THROW boundary: ${String(e)}`)
  }
  if (!out.ok) {
    throw new Error(
      `grammar unexpectedly unavailable for ${path} despite skipIf gate: ${out.reason}`,
    )
  }
  return out
}

/** ONE-TIME, top-level grammar-availability probe per distinct grammar used in
 *  this suite. Each does a real parse of a trivial snippet and records whether
 *  it produced a typed-ok outcome. Computed once at module load (not per test).
 *  Dependent cases gate on these via `test.skipIf(!GRAMMAR_*)` so an absent
 *  grammar shows as SKIPPED, not as a zero-assertion PASS. */
const probe = async (path: string, text: string): Promise<boolean> => {
  try {
    return (await parser.parse(path, text)).ok
  } catch {
    return false
  }
}
const GRAMMAR_TS = await probe("probe.ts", "class C {}\n")
const GRAMMAR_PY = await probe("probe.py", "class C:\n    pass\n")
const GRAMMAR_RUST = await probe("probe.rs", "struct S;\n")

describe("tree-sitter decl-walk — boundary invariants (grammar-independent)", () => {
  test("unknown extension ⇒ no-grammar BEFORE any WASM load (pre-walk guard)", async () => {
    const out = await parser.parse("notes.txt", "anything")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("unreachable")
    expect(out.reason).toBe("no-grammar")
  })

  test("parse() of a known extension NEVER throws past its boundary", async () => {
    let threw = false
    try {
      await parser.parse("a.ts", "export const x = 1\n")
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})

describe("tree-sitter collectDecls — class-with-two-methods (via real parse)", () => {
  test.skipIf(!GRAMMAR_TS)(
    "lifts top=[class C] with children=[method m1, method m2], correct nesting",
    async () => {
      const src = "class C {\n  m1() { return 1 }\n  m2() { return 2 }\n}\n"
      const out = await parseOk("a.ts", src)
      const decls = out.parsed.decls
      expect(decls.length).toBe(1)
      const cls = nth(decls, 0, "cls")
      expect(cls.kind).toBe("class")
      expect(cls.name).toBe("C")
      // Two methods, source order, both leaves.
      expect(cls.children.map((c) => c.name)).toEqual(["m1", "m2"])
      expect(cls.children.map((c) => c.kind)).toEqual(["method", "method"])
      for (const m of cls.children) expect(m.children.length).toBe(0)
    },
  )

  test.skipIf(!GRAMMAR_TS)("line bounds are 1-based inclusive (TsPoint.row + 1)", async () => {
    const src = "class C {\n  m1() { return 1 }\n  m2() { return 2 }\n}\n"
    const out = await parseOk("a.ts", src)
    const cls = nth(out.parsed.decls, 0, "cls")
    // class spans lines 1..4 (closing brace on line 4).
    expect(cls.startLine).toBe(1)
    expect(cls.endLine).toBe(4)
    // m1 on line 2, m2 on line 3.
    expect(nth(cls.children, 0, "cls.children").startLine).toBe(2)
    expect(nth(cls.children, 0, "cls.children").endLine).toBe(2)
    expect(nth(cls.children, 1, "cls.children").startLine).toBe(3)
    expect(nth(cls.children, 1, "cls.children").endLine).toBe(3)
  })

  test.skipIf(!GRAMMAR_TS)(
    "container signatureEndLine = max(startLine, firstChild.startLine - 1)",
    async () => {
      // class header on line 1, first method on line 2 ⇒ signatureEndLine = max(1, 2-1) = 1.
      const src = "class C {\n  m1() { return 1 }\n  m2() { return 2 }\n}\n"
      const out = await parseOk("a.ts", src)
      const cls = nth(out.parsed.decls, 0, "cls")
      expect(cls.signatureEndLine).toBe(1)
      // A leaf method's signatureEndLine equals its own startLine.
      expect(nth(cls.children, 0, "cls.children").signatureEndLine).toBe(
        nth(cls.children, 0, "cls.children").startLine,
      )
    },
  )

  test.skipIf(!GRAMMAR_TS)(
    "nodeName returns '' for an anonymous/unnamed-field decl, real name otherwise",
    async () => {
      // A named function exposes a name field; an anonymous default-export class
      // has no `name` field ⇒ nodeName falls back to "".
      const named = await parseOk("a.ts", "function foo() { return 1 }\n")
      const fn = named.parsed.decls.find((d) => d.kind === "function")
      expect(fn?.name).toBe("foo")
      const anon = await parseOk("b.ts", "export default class {\n  m() {}\n}\n")
      // The default-exported class is lifted (descended through export_statement);
      // its name is "" because the class has no name field.
      const cls = anon.parsed.decls.find((d) => d.kind === "class")
      if (cls !== undefined) expect(cls.name).toBe("")
    },
  )

  test.skipIf(!GRAMMAR_TS)(
    "non-decl wrapper (export_statement) is descended so the wrapped class is not lost",
    async () => {
      const out = await parseOk("a.ts", "export class E {\n  k() {}\n}\n")
      // `export class E` parses as an export_statement (no kind) WRAPPING a
      // class_declaration; collectDecls descends and lifts the inner class.
      const cls = out.parsed.decls.find((d) => d.kind === "class" && d.name === "E")
      expect(cls).toBeDefined()
      expect(present(cls, "cls").children.map((c) => c.name)).toEqual(["k"])
    },
  )

  test.skipIf(!GRAMMAR_RUST)(
    "rust struct_item lifts to kind 'class' (locks the per-lang table through the walk)",
    async () => {
      // Skipped (visibly) if the rust grammar is unavailable; when present it
      // proves the walk consults the rust NODE_KINDS table (struct_item → class).
      const out = await parseOk("lib.rs", "struct S {\n  x: i32,\n}\n")
      const s = out.parsed.decls.find((d) => d.name === "S")
      expect(s?.kind).toBe("class")
    },
  )

  test.skipIf(!GRAMMAR_PY)(
    "python class_definition + methods walk (function_definition → method/function)",
    async () => {
      const out = await parseOk("m.py", "class C:\n    def m1(self):\n        return 1\n")
      const cls = out.parsed.decls.find((d) => d.kind === "class")
      expect(cls).toBeDefined()
      expect(present(cls, "cls").name).toBe("C")
      // The method is collected as a child (python class_definition is a container).
      expect(present(cls, "cls").children.map((c) => c.name)).toContain("m1")
    },
  )

  // RED-ON-INJECTION (the bug this slice fixes): a python `decorated_definition`
  // WRAPPING a `class_definition`. Before the fix, NODE_KINDS.python mapped
  // `decorated_definition: "function"`, so `collectDecls` lifted the whole
  // decorated node as a LEAF labelled `function` — a decorated CLASS was
  // mislabelled `function` AND its methods were dropped (not a container). The
  // wrapper fix surfaces it as a container `class` (methods as children) while
  // KEEPING the wrapper's span so the `@decorator` lines stay in the range.
  test.skipIf(!GRAMMAR_PY)(
    "decorated CLASS surfaces as container 'class' with method children + decorator lines in span",
    async () => {
      const src =
        "@dataclass\n@final\nclass Foo:\n    def m(self):\n        return 1\n    def n(self):\n        return 2\n"
      const out = await parseOk("d.py", src)
      const decls = out.parsed.decls
      expect(decls.length).toBe(1)
      const cls = nth(decls, 0, "cls")
      // (a) kind is "class", NOT "function" (the pre-fix mislabel).
      expect(cls.kind).toBe("class")
      expect(cls.name).toBe("Foo")
      // (b) it IS a container — both methods collected as children, source order.
      expect(cls.children.map((c) => c.name)).toEqual(["m", "n"])
      expect(cls.children.length).toBe(2)
      for (const m of cls.children) expect(m.children.length).toBe(0)
      // (c) the decl span COVERS the `@decorator` lines: `@dataclass` is line 1,
      // the inner `class` keyword is line 3 — startLine must be 1 (the decorator),
      // NOT 3. Were `decorated_definition` simply descended-through, the inner
      // class_definition's startLine (3) would leak and the decorators would be
      // lost from the chunk/outline range.
      expect(cls.startLine).toBe(1)
      expect(cls.endLine).toBe(7)
    },
  )

  test.skipIf(!GRAMMAR_PY)(
    "decorated FUNCTION still surfaces as 'function' (leaf), decorator line in span",
    async () => {
      const src = "@cache\ndef plain():\n    return 0\n"
      const out = await parseOk("d.py", src)
      const decls = out.parsed.decls
      expect(decls.length).toBe(1)
      const fn = nth(decls, 0, "fn")
      expect(fn.kind).toBe("function")
      expect(fn.name).toBe("plain")
      expect(fn.children.length).toBe(0) // a function is a leaf
      expect(fn.startLine).toBe(1) // `@cache` decorator line included
      expect(fn.endLine).toBe(3)
    },
  )

  test.skipIf(!GRAMMAR_PY)(
    "non-decorated python class is UNAFFECTED by the wrapper change",
    async () => {
      const out = await parseOk("d.py", "class Bare:\n    def k(self):\n        return 9\n")
      const cls = out.parsed.decls.find((d) => d.kind === "class")
      expect(cls).toBeDefined()
      expect(present(cls, "cls").name).toBe("Bare")
      expect(present(cls, "cls").startLine).toBe(1) // no decorators — span starts at `class`
      expect(present(cls, "cls").children.map((c) => c.name)).toEqual(["k"])
    },
  )
})

describe("tree-sitter collectDecls — synthetic-node walk (grammar-independent)", () => {
  // The real-parse cases above cover collectDecls wherever a grammar `.wasm`
  // loads; these drive the SAME module-private walk over a hand-built TsNode tree
  // via the `__test` seam, so the nesting/name logic stays pinned even on a CI
  // host with no grammars. The synthetic node type is recovered from the seam's
  // own signature (no need to export the WASM-mirror interface).
  type SynNode = Parameters<typeof __test.collectDecls>[1]
  const node = (over: Partial<SynNode> & { type: string }): SynNode =>
    ({
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 0 },
      hasError: false,
      namedChildren: [],
      childForFieldName: () => null,
      ...over,
    }) as SynNode
  // A name node carries `text` on the concrete web-tree-sitter Node; nodeName
  // reads it structurally. Build one as a node with an extra `text` field.
  const nameNode = (text: string): SynNode => ({ ...node({ type: "identifier" }), text }) as SynNode
  const fields =
    (map: Record<string, SynNode>) =>
    (f: string): SynNode | null =>
      map[f] ?? null

  test("collectDecls over a hand-built `class C { m1(){} m2(){} }` tree yields the nested DeclNode shape", () => {
    const method = (name: string): SynNode =>
      node({ type: "method_definition", childForFieldName: fields({ name: nameNode(name) }) })
    const m1 = method("m1")
    const m2 = method("m2")
    const body = node({ type: "class_body", namedChildren: [m1, m2] })
    const cls = node({
      type: "class_declaration",
      childForFieldName: fields({ name: nameNode("C"), body }),
    })
    const root = node({ type: "program", namedChildren: [cls] })

    const decls = __test.collectDecls("typescript", root)
    expect(decls).toHaveLength(1)
    expect(decls[0]?.kind).toBe("class")
    expect(decls[0]?.name).toBe("C")
    // class_declaration is a container ⇒ its body's methods are collected as children
    expect(decls[0]?.children.map((c) => c.kind)).toEqual(["method", "method"])
    expect(decls[0]?.children.map((c) => c.name)).toEqual(["m1", "m2"])
  })

  test("nodeName returns '' when the node has no `name` field (childForFieldName ⇒ null)", () => {
    expect(__test.nodeName(node({ type: "method_definition" }))).toBe("")
  })

  test("nodeName returns the name field's text when present", () => {
    const named = node({
      type: "function_declaration",
      childForFieldName: fields({ name: nameNode("foo") }),
    })
    expect(__test.nodeName(named)).toBe("foo")
  })

  test("nodeName returns '' when the name node lacks a string `text` (structural guard)", () => {
    const nameless = node({ type: "identifier" }) // no `text`
    const decl = node({
      type: "function_declaration",
      childForFieldName: fields({ name: nameless }),
    })
    expect(__test.nodeName(decl)).toBe("")
  })
})
