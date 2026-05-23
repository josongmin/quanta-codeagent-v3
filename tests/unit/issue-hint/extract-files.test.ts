/**
 * `extractFiles` — conservative path extraction.
 *
 * Conservative posture: we only emit a path when its shape is unambiguously
 * a path (≥1 slash + recognized extension). Bare module names like `models.py`
 * are intentionally rejected here (their context — traceback frames — is
 * captured by `extractTracebackPaths` instead).
 */
import { describe, expect, test } from "bun:test"
import { extractFiles } from "../../../src/agent/issue-hint/extract-files"

describe("extractFiles — conservative path extraction", () => {
  test("empty / non-string input → []", () => {
    expect(extractFiles("")).toEqual([])
    // typed escape — runtime defensive check
    expect(extractFiles(undefined as unknown as string)).toEqual([])
  })

  test("recognized path with slash + extension is extracted", () => {
    const out = extractFiles("see requests/models.py for context")
    expect(out).toEqual(["requests/models.py"])
  })

  test("multiple distinct paths are deduped and sorted", () => {
    const out = extractFiles("touch src/_pytest/pathlib.py and src/_pytest/main.py")
    expect(out).toEqual(["src/_pytest/main.py", "src/_pytest/pathlib.py"])
  })

  test("path:line:col suffix is stripped to bare path", () => {
    const out = extractFiles("crashed at requests/models.py:401:12")
    expect(out).toEqual(["requests/models.py"])
  })

  test("path:line suffix is stripped", () => {
    const out = extractFiles("see lib/foo.ts:42")
    expect(out).toEqual(["lib/foo.ts"])
  })

  test("bare module name (no slash) is REJECTED — too ambiguous", () => {
    // Conservative-by-design: `models.py` alone could be anywhere.
    expect(extractFiles("the bug is in models.py")).toEqual([])
  })

  test("multiple languages recognized", () => {
    const out = extractFiles("fix a/b.py and c/d.ts and e/f.go and g/h.rs and i/j.java and k/l.rb")
    expect(out).toEqual(["a/b.py", "c/d.ts", "e/f.go", "g/h.rs", "i/j.java", "k/l.rb"])
  })

  test("unrecognized extension is REJECTED", () => {
    expect(extractFiles("see docs/foo.docx for details")).toEqual([])
    expect(extractFiles("see a/b.exe")).toEqual([])
  })

  test("path longer than 200 chars is REJECTED", () => {
    const long = `a/${"x".repeat(250)}.py`
    expect(extractFiles(`crash in ${long} oops`)).toEqual([])
  })

  test("prototype-pollution: path starting with __proto__ is REJECTED", () => {
    // Slash requirement already excludes bare `__proto__`; we also guard.
    expect(extractFiles("see __proto__/foo.py")).toEqual([])
    expect(extractFiles("see constructor/foo.py")).toEqual([])
    expect(extractFiles("see prototype/foo.py")).toEqual([])
  })

  test("output is sorted-unique deterministically across many duplicates", () => {
    const text = "a/b.py a/b.py a/b.py b/c.py b/c.py"
    expect(extractFiles(text)).toEqual(["a/b.py", "b/c.py"])
  })

  test("nested deep path is OK", () => {
    expect(extractFiles("touch src/agent/issue-hint/extract-files.ts")).toEqual([
      "src/agent/issue-hint/extract-files.ts",
    ])
  })

  test("dotted-extension shapes work (yaml/yml/toml/json)", () => {
    const out = extractFiles("see config/a.yaml or config/b.yml or pkg/c.toml or pkg/d.json")
    expect(out).toEqual(["config/a.yaml", "config/b.yml", "pkg/c.toml", "pkg/d.json"])
  })

  test("path inside parens (markdown link) is extracted", () => {
    const text = "see [this line](https://github.com/psf/requests/blob/.../requests/models.py#L401)"
    const out = extractFiles(text)
    // We don't try to parse markdown — we just find path-shaped substrings.
    expect(out).toContain("requests/models.py")
  })

  test("regex is reset between calls (no lastIndex leak)", () => {
    // Same input twice — must return same result.
    const text = "a/b.py"
    expect(extractFiles(text)).toEqual(["a/b.py"])
    expect(extractFiles(text)).toEqual(["a/b.py"])
    expect(extractFiles(text)).toEqual(["a/b.py"])
  })
})
