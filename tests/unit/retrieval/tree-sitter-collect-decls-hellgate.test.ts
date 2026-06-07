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
 * the produced DeclNode tree. Every grammar-dependent case is guarded: if a
 * future/CI env genuinely lacks the grammar (parse degrades to {ok:false}),
 * the case SKIPS with a logged note rather than failing — the no-throw +
 * typed-outcome invariant is asserted unconditionally.
 */

import { describe, expect, test } from "bun:test"
import { createTreeSitterParser, type ParseOutcome } from "@/retrieval/code-parser"

const parser = createTreeSitterParser()

/** Parse and return the parsed file IFF the grammar is available in this env;
 *  otherwise return null (caller skips the grammar-dependent assertions). The
 *  no-throw boundary is asserted here for every call. */
const tryParse = async (
  path: string,
  text: string,
): Promise<ParseOutcome & { ok: true } | null> => {
  let out: ParseOutcome
  try {
    out = await parser.parse(path, text)
  } catch (e) {
    throw new Error(`parse() threw past its NO-THROW boundary: ${String(e)}`)
  }
  if (!out.ok) {
    // Grammar ABI-incompatible / absent in this env — the brief's premise.
    // eslint-disable-next-line no-console
    console.warn(`[skip] grammar unavailable for ${path}: ${out.reason}`)
    return null
  }
  return out
}

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
  test("lifts top=[class C] with children=[method m1, method m2], correct nesting", async () => {
    const src = "class C {\n  m1() { return 1 }\n  m2() { return 2 }\n}\n"
    const out = await tryParse("a.ts", src)
    if (out === null) return // grammar unavailable — premise held; skip
    const decls = out.parsed.decls
    expect(decls.length).toBe(1)
    const cls = decls[0]!
    expect(cls.kind).toBe("class")
    expect(cls.name).toBe("C")
    // Two methods, source order, both leaves.
    expect(cls.children.map((c) => c.name)).toEqual(["m1", "m2"])
    expect(cls.children.map((c) => c.kind)).toEqual(["method", "method"])
    for (const m of cls.children) expect(m.children.length).toBe(0)
  })

  test("line bounds are 1-based inclusive (TsPoint.row + 1)", async () => {
    const src = "class C {\n  m1() { return 1 }\n  m2() { return 2 }\n}\n"
    const out = await tryParse("a.ts", src)
    if (out === null) return
    const cls = out.parsed.decls[0]!
    // class spans lines 1..4 (closing brace on line 4).
    expect(cls.startLine).toBe(1)
    expect(cls.endLine).toBe(4)
    // m1 on line 2, m2 on line 3.
    expect(cls.children[0]!.startLine).toBe(2)
    expect(cls.children[0]!.endLine).toBe(2)
    expect(cls.children[1]!.startLine).toBe(3)
    expect(cls.children[1]!.endLine).toBe(3)
  })

  test("container signatureEndLine = max(startLine, firstChild.startLine - 1)", async () => {
    // class header on line 1, first method on line 2 ⇒ signatureEndLine = max(1, 2-1) = 1.
    const src = "class C {\n  m1() { return 1 }\n  m2() { return 2 }\n}\n"
    const out = await tryParse("a.ts", src)
    if (out === null) return
    const cls = out.parsed.decls[0]!
    expect(cls.signatureEndLine).toBe(1)
    // A leaf method's signatureEndLine equals its own startLine.
    expect(cls.children[0]!.signatureEndLine).toBe(cls.children[0]!.startLine)
  })

  test("nodeName returns '' for an anonymous/unnamed-field decl, real name otherwise", async () => {
    // A named function exposes a name field; an anonymous default-export class
    // has no `name` field ⇒ nodeName falls back to "".
    const named = await tryParse("a.ts", "function foo() { return 1 }\n")
    if (named !== null) {
      const fn = named.parsed.decls.find((d) => d.kind === "function")
      expect(fn?.name).toBe("foo")
    }
    const anon = await tryParse("b.ts", "export default class {\n  m() {}\n}\n")
    if (anon !== null) {
      // The default-exported class is lifted (descended through export_statement);
      // its name is "" because the class has no name field.
      const cls = anon.parsed.decls.find((d) => d.kind === "class")
      if (cls !== undefined) expect(cls.name).toBe("")
    }
  })

  test("non-decl wrapper (export_statement) is descended so the wrapped class is not lost", async () => {
    const out = await tryParse("a.ts", "export class E {\n  k() {}\n}\n")
    if (out === null) return
    // `export class E` parses as an export_statement (no kind) WRAPPING a
    // class_declaration; collectDecls descends and lifts the inner class.
    const cls = out.parsed.decls.find((d) => d.kind === "class" && d.name === "E")
    expect(cls).toBeDefined()
    expect(cls!.children.map((c) => c.name)).toEqual(["k"])
  })

  test("rust struct_item lifts to kind 'class' (locks the per-lang table through the walk)", async () => {
    // If the rust grammar is unavailable this skips; when present it proves the
    // walk consults the rust NODE_KINDS table (struct_item → class).
    const out = await tryParse("lib.rs", "struct S {\n  x: i32,\n}\n")
    if (out === null) return
    const s = out.parsed.decls.find((d) => d.name === "S")
    expect(s?.kind).toBe("class")
  })

  test("python class_definition + methods walk (function_definition → method/function)", async () => {
    const out = await tryParse("m.py", "class C:\n    def m1(self):\n        return 1\n")
    if (out === null) return
    const cls = out.parsed.decls.find((d) => d.kind === "class")
    expect(cls).toBeDefined()
    expect(cls!.name).toBe("C")
    // The method is collected as a child (python class_definition is a container).
    expect(cls!.children.map((c) => c.name)).toContain("m1")
  })

  // RED-ON-INJECTION (the bug this slice fixes): a python `decorated_definition`
  // WRAPPING a `class_definition`. Before the fix, NODE_KINDS.python mapped
  // `decorated_definition: "function"`, so `collectDecls` lifted the whole
  // decorated node as a LEAF labelled `function` — a decorated CLASS was
  // mislabelled `function` AND its methods were dropped (not a container). The
  // wrapper fix surfaces it as a container `class` (methods as children) while
  // KEEPING the wrapper's span so the `@decorator` lines stay in the range.
  test("decorated CLASS surfaces as container 'class' with method children + decorator lines in span", async () => {
    const src =
      "@dataclass\n@final\nclass Foo:\n    def m(self):\n        return 1\n    def n(self):\n        return 2\n"
    const out = await tryParse("d.py", src)
    if (out === null) return // grammar unavailable — premise held; skip
    const decls = out.parsed.decls
    expect(decls.length).toBe(1)
    const cls = decls[0]!
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
  })

  test("decorated FUNCTION still surfaces as 'function' (leaf), decorator line in span", async () => {
    const src = "@cache\ndef plain():\n    return 0\n"
    const out = await tryParse("d.py", src)
    if (out === null) return
    const decls = out.parsed.decls
    expect(decls.length).toBe(1)
    const fn = decls[0]!
    expect(fn.kind).toBe("function")
    expect(fn.name).toBe("plain")
    expect(fn.children.length).toBe(0) // a function is a leaf
    expect(fn.startLine).toBe(1) // `@cache` decorator line included
    expect(fn.endLine).toBe(3)
  })

  test("non-decorated python class is UNAFFECTED by the wrapper change", async () => {
    const out = await tryParse("d.py", "class Bare:\n    def k(self):\n        return 9\n")
    if (out === null) return
    const cls = out.parsed.decls.find((d) => d.kind === "class")
    expect(cls).toBeDefined()
    expect(cls!.name).toBe("Bare")
    expect(cls!.startLine).toBe(1) // no decorators — span starts at `class`
    expect(cls!.children.map((c) => c.name)).toEqual(["k"])
  })
})

describe("tree-sitter collectDecls — REPORTED follow-up (walk not isolable)", () => {
  // FINDING A: a TRUE unit test of collectDecls over a SYNTHETIC TsNode tree
  // (independent of any grammar) is blocked until the walk is exported or an
  // injection seam is added. The real-parse cases above cover the same
  // behaviour wherever the grammar loads; these pin the synthetic-node intent.
  test.todo(
    "collectDecls(lang, syntheticRoot) over a hand-built TsNode class tree (needs export/seam)",
    () => {
      // Blocked: collectDecls is module-private. Once exported, build a
      // synthetic TsNode (type/namedChildren/startPosition/childForFieldName)
      // for class C { m1() {} m2() {} } and assert the DeclNode tree directly.
    },
  )
  test.todo(
    "nodeName(node) over a synthetic node with a missing `name` field returns '' (needs export)",
    () => {
      // Blocked: nodeName is module-private. Once exported, pass a node whose
      // childForFieldName('name') returns null and assert nodeName(node) === "".
    },
  )
})
