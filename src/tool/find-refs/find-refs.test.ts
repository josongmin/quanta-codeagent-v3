import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "bun:test"
import type { ToolContext, ToolEvent } from "../types"
import {
  buildFindRefsArgv,
  findReferencesTool,
  formatFindRefs,
  isDefinitionLine,
} from "./index"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (input: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> => {
  let out = { ok: false, output: "(no result)" }
  for await (const ev of findReferencesTool.execute(input as never, ctx(cwd)) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") out = ev.result as { ok: boolean; output: string }
  }
  return out
}

describe("buildFindRefsArgv — injection/whole-word boundary (pure)", () => {
  it("always emits -F (fixed string) AND -w (whole word) so a symbol is a literal word, not a regex", () => {
    const argv = buildFindRefsArgv({ symbol: "Add" })
    expect(argv).toContain("-F")
    expect(argv).toContain("-w")
    // symbol passed via -e, single-quoted (one shell token, no injection)
    expect(argv).toContain("-e")
    expect(argv).toContain("'Add'")
  })

  it("a regex-metachar symbol is inert under -F (no pattern injection)", () => {
    const argv = buildFindRefsArgv({ symbol: "_imp_(.*)" })
    // -F makes it literal; it is shell-quoted as a single token
    expect(argv).toContain("-F")
    expect(argv.join(" ")).toContain("'_imp_(.*)'")
  })

  it("type filter is shell-quoted; absent path emits no path token", () => {
    const argv = buildFindRefsArgv({ symbol: "x", type: "py" })
    expect(argv).toContain("--type")
    expect(argv).toContain("'py'")
    // no trailing bare path
    expect(argv.at(-1)).toBe("'x'")
  })

  it("jailed path is appended as a quoted token", () => {
    const argv = buildFindRefsArgv({ symbol: "x" }, "/work/sandbox/sub")
    expect(argv.at(-1)).toBe("'/work/sandbox/sub'")
  })
})

describe("isDefinitionLine — def vs use classification (pure)", () => {
  it("flags declarations across languages", () => {
    expect(isDefinitionLine("def _postprocessor(expr):", "_postprocessor")).toBe(true)
    expect(isDefinitionLine("class MatAdd(MatrixExpr):", "MatAdd")).toBe(true)
    expect(isDefinitionLine("function parseInput(x) {", "parseInput")).toBe(true)
    expect(isDefinitionLine("fn resolve_owner(cwd: &str) {", "resolve_owner")).toBe(true)
    expect(isDefinitionLine("    foo = compute()", "foo")).toBe(true)
    expect(isDefinitionLine("    foo: int = 3", "foo")).toBe(true)
  })

  it("does NOT flag plain uses or comparisons", () => {
    expect(isDefinitionLine("result = _postprocessor(expr)", "_postprocessor")).toBe(false)
    expect(isDefinitionLine("return MatAdd(*args)", "MatAdd")).toBe(false)
    expect(isDefinitionLine("if foo == 1:", "foo")).toBe(false) // comparison, not assignment
    expect(isDefinitionLine("self.obj.foo", "foo")).toBe(false)
  })
})

describe("formatFindRefs — grouping/cap (pure)", () => {
  it("lists definition-like rows FIRST and counts files", () => {
    const stdout = [
      "a/use.py:10:    return _postprocessor(x)",
      "a/def.py:5:def _postprocessor(expr):",
      "b/use.py:20:    y = _postprocessor(z)",
    ].join("\n")
    const out = formatFindRefs(stdout, "_postprocessor")
    expect(out).toContain("3 reference(s) in 3 file(s)")
    expect(out).toContain("1 definition-like")
    // def row marked + appears before the use rows
    const defIdx = out.indexOf("[def] a/def.py:5:")
    const useIdx = out.indexOf("a/use.py:10:")
    expect(defIdx).toBeGreaterThan(-1)
    expect(defIdx).toBeLessThan(useIdx)
  })

  it("caps at 200 rows and signals overflow", () => {
    const stdout = Array.from({ length: 250 }, (_, i) => `f${i}.py:1:foo()`).join("\n")
    const out = formatFindRefs(stdout, "foo")
    expect(out).toContain("more")
    expect(out.match(/foo\(\)/g)?.length).toBe(200)
    expect(out).toContain("f199.py:1:foo()")
    expect(out).not.toContain("f200.py:1:foo()")
  })
})

describe("find_references execute — REAL ripgrep, whole-word boundary (integration)", () => {
  const root = mkdtempSync(join(tmpdir(), "findrefs-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("matches the symbol as a WHOLE WORD and NOT as a substring (the core value over grep)", async () => {
    mkdirSync(join(root, "pkg"), { recursive: true })
    // `Add` appears: (a) as a whole-word use, (b) as a definition, and as a
    // SUBSTRING inside `MatAdd`/`Address` which MUST NOT match under -w.
    writeFileSync(
      join(root, "pkg", "core.py"),
      ["class Add(Expr):", "    pass", "result = Add(1, 2)"].join("\n"),
    )
    // NOTE: keep the literal word "Add" OUT of this file entirely (even in
    // comments) — only the SUBSTRINGS MatAdd / address appear, which `-w` must skip.
    writeFileSync(
      join(root, "pkg", "matrices.py"),
      ["class MatAdd(MatExpr):  # composite name", "address = 1  # composite name"].join("\n"),
    )
    const r = await run({ symbol: "Add" }, root)
    expect(r.ok).toBe(true)
    // whole-word `Add` hits found
    expect(r.output).toContain("pkg/core.py")
    // the definition is classified
    expect(r.output).toContain("[def]")
    // substring occurrences MUST be absent (no MatAdd / address line)
    expect(r.output).not.toContain("MatAdd")
    expect(r.output).not.toContain("address = 1")
  })

  it("treats a dunder/metachar symbol as a LITERAL whole word (-F -w): matches __add__ as a word, not inside my__add__var", async () => {
    mkdirSync(join(root, "meta"), { recursive: true })
    writeFileSync(
      join(root, "meta", "m.py"),
      [
        "def __add__(self): pass", // dunder DEFINITION → must match + classify [def]
        "x = a.__add__(b)", // dunder use (.__add__( → word-bounded) → match
        "y = my__add__var", // SUBSTRING inside a longer identifier → must NOT match under -w
      ].join("\n"),
    )
    const r = await run({ symbol: "__add__" }, root)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("meta/m.py")
    expect(r.output).toContain("[def]") // the `def __add__` line classified
    expect(r.output).not.toContain("my__add__var") // substring occurrence excluded by -w
  })

  it("returns ok with a clear 0-references message (not an error) when the symbol is absent", async () => {
    const r = await run({ symbol: "ThisSymbolDoesNotExistAnywhere" }, root)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("0 references")
  })

  it("NO-THROW + ok:false when the path escapes the workspace jail", async () => {
    const r = await run({ symbol: "Add", path: "../../../../etc" }, root)
    expect(r.ok).toBe(false)
  })
})
