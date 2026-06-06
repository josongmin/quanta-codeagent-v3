/**
 * HELLGATE — outline read render (RFC jun-6-syntax-aware-chunking §6.2).
 *
 * Drives `renderOutline` (pure) with hand-built `ParsedFile`s + source text:
 *   - elides bodies, keeps SIGNATURES verbatim, one `// … (<N> lines)` per body;
 *   - nested decls: a class emits its header, each method signature + `// …`,
 *     and the closing line;
 *   - budget cap: stops at a decl boundary, appends `… more declarations elided`;
 *   - surrogate-safe: a lone surrogate / emoji on a signature line never
 *     corrupts the output (cuts are whole-line);
 *   - boundary inputs (empty decls, 1-line file, zero budget) produce a
 *     well-defined small output, NO-THROW.
 */

import { describe, expect, test } from "bun:test"
import type { ParsedFile } from "@/retrieval"
import { renderOutline } from "@/tool/read/outline"

describe("read-outline hellgate", () => {
  test("elides bodies, keeps signatures verbatim, one indicator per body", () => {
    const text = ["function add(a, b) {", "  const x = a + b", "  return x", "}"].join("\n")
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "function",
          name: "add",
          startLine: 1,
          endLine: 4,
          signatureEndLine: 1,
          children: [],
        },
      ],
    }
    const out = renderOutline(text, parsed, 4000)
    expect(out).toContain("function add(a, b) {")
    // body lines elided.
    expect(out).not.toContain("const x = a + b")
    expect(out).not.toContain("return x")
    // 3-line body (lines 2,3,4 after signatureEndLine=1).
    expect(out).toContain("// … (3 lines)")
  })

  test("nested decls — class header + per-method signatures + // … + closing brace", () => {
    const text = [
      "class Foo {", // 1
      "  bar() {", // 2
      "    return 1", // 3
      "  }", // 4
      "  baz() {", // 5
      "    return 2", // 6
      "  }", // 7
      "}", // 8
    ].join("\n")
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "class",
          name: "Foo",
          startLine: 1,
          endLine: 8,
          signatureEndLine: 1,
          children: [
            {
              kind: "method",
              name: "bar",
              startLine: 2,
              endLine: 4,
              signatureEndLine: 2,
              children: [],
            },
            {
              kind: "method",
              name: "baz",
              startLine: 5,
              endLine: 7,
              signatureEndLine: 5,
              children: [],
            },
          ],
        },
      ],
    }
    const out = renderOutline(text, parsed, 4000)
    expect(out).toContain("class Foo {")
    expect(out).toContain("  bar() {")
    expect(out).toContain("  baz() {")
    expect(out).toContain("}")
    // method bodies elided.
    expect(out).not.toContain("return 1")
    expect(out).not.toContain("return 2")
  })

  test("budget cap — stops at a decl boundary + appends elided marker, <= budget-ish", () => {
    const lines: string[] = []
    const decls: ParsedFile["decls"] = []
    for (let i = 0; i < 20; i++) {
      const start = i * 3 + 1
      lines.push(`function f${i}() {`, `  return ${i}`, "}")
      decls.push({
        kind: "function",
        name: `f${i}`,
        startLine: start,
        endLine: start + 2,
        signatureEndLine: start,
        children: [],
      })
    }
    const out = renderOutline(lines.join("\n"), { lang: "typescript", decls }, 80)
    expect(out).toContain("more declarations elided")
    // The first function always renders (head is useful even on a tiny budget).
    expect(out).toContain("function f0()")
    // Did NOT render all 20.
    expect(out).not.toContain("function f19()")
  })

  test("surrogate-safe — lone surrogate / emoji on a signature line never corrupts", () => {
    const emoji = "\u{1F600}" // astral (surrogate pair)
    const lone = "\uD83D" // lone HIGH surrogate
    const text = [`const s = "${emoji}${lone}label" // sig`, "  doStuff()", "}"].join("\n")
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        { kind: "const", name: "s", startLine: 1, endLine: 3, signatureEndLine: 1, children: [] },
      ],
    }
    const out = renderOutline(text, parsed, 4000)
    // The signature line survives intact (whole-line, never sliced mid-surrogate).
    expect(out).toContain(`const s = "${emoji}${lone}label" // sig`)
    expect(out).toContain("// … (2 lines)")
  })

  test("no declarations ⇒ a well-defined sentinel, NO-THROW", () => {
    const out = renderOutline("just text\nmore", { lang: "typescript", decls: [] }, 4000)
    expect(out).toBe("(no declarations)")
  })

  test("1-line body-less decl ⇒ signature only, no indicator", () => {
    const text = "const x = 1"
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        { kind: "const", name: "x", startLine: 1, endLine: 1, signatureEndLine: 1, children: [] },
      ],
    }
    const out = renderOutline(text, parsed, 4000)
    expect(out).toBe("const x = 1")
    expect(out).not.toContain("// …")
  })

  test("zero/negative-ish tiny budget ⇒ at least the first decl renders, bounded", () => {
    const text = ["function a() {", "  body", "}", "function b() {", "  body", "}"].join("\n")
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "function",
          name: "a",
          startLine: 1,
          endLine: 3,
          signatureEndLine: 1,
          children: [],
        },
        {
          kind: "function",
          name: "b",
          startLine: 4,
          endLine: 6,
          signatureEndLine: 4,
          children: [],
        },
      ],
    }
    const out = renderOutline(text, parsed, 1)
    expect(out).toContain("function a()")
    expect(out).toContain("more declarations elided")
  })

  test("determinism — same input ⇒ identical outline twice", () => {
    const text = ["function a() {", "  x", "}"].join("\n")
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "function",
          name: "a",
          startLine: 1,
          endLine: 3,
          signatureEndLine: 1,
          children: [],
        },
      ],
    }
    expect(renderOutline(text, parsed, 100)).toBe(renderOutline(text, parsed, 100))
  })
})
