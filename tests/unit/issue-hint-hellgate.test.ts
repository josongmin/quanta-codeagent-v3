/**
 * Hellgate: adversarial inputs against the issue-hint extractor surface.
 *
 * Coverage axes (Codex/Cursor-style hellgate convention):
 *   - prototype pollution (`__proto__`, `constructor`, `prototype`)
 *   - ANSI escape codes interleaved with valid signals
 *   - empty / very large inputs (10MB)
 *   - deeply nested / unbalanced backticks
 *   - Unicode (한글 / RTL / emoji)
 *   - regex-DoS shaped input (long runs of the same char)
 *   - exactOptionalPropertyTypes compatibility (no `undefined` slipped in)
 *   - typed escape (`undefined as any`, `null`, non-string) handled defensively
 *
 * Failure mode: any extractor throwing on hostile input, or any extractor
 * emitting a prototype-pollution key, FAILS this gate.
 */
import { describe, expect, test } from "bun:test"
import {
  composeIssueHint,
  extractCodeFences,
  extractErrors,
  extractFiles,
  extractIssueHint,
  extractSymbols,
  extractTracebackPaths,
} from "../../src/agent/issue-hint"

const POLLUTION_TOKENS = ["__proto__", "constructor", "prototype"]

describe("issue-hint hellgate — adversarial inputs (25+ cases)", () => {
  test("h01: empty string input across all extractors", () => {
    expect(extractFiles("")).toEqual([])
    expect(extractSymbols("")).toEqual([])
    expect(extractErrors("")).toEqual([])
    expect(extractCodeFences("")).toEqual([])
    expect(extractTracebackPaths("")).toEqual([])
    const h = extractIssueHint("")
    expect(h).toEqual({
      files: [],
      symbols: [],
      errors: [],
      codeFences: [],
      tracebackPaths: [],
    })
  })

  test("h02: non-string input handled defensively (no throw)", () => {
    expect(extractFiles(undefined as unknown as string)).toEqual([])
    expect(extractSymbols(null as unknown as string)).toEqual([])
    expect(extractErrors(42 as unknown as string)).toEqual([])
    expect(extractCodeFences({} as unknown as string)).toEqual([])
    expect(extractTracebackPaths([] as unknown as string)).toEqual([])
    expect(extractIssueHint(undefined as unknown as string)).toEqual({
      files: [],
      symbols: [],
      errors: [],
      codeFences: [],
      tracebackPaths: [],
    })
  })

  test("h03: prototype-pollution tokens NEVER appear in output", () => {
    const hostile =
      POLLUTION_TOKENS.join(" ") +
      " __proto__/foo.py prototype/bar.py constructor/baz.py" +
      " def __proto__(): class constructor: `prototype` `__proto__`"
    const h = extractIssueHint(hostile)
    const allTokens = [...h.files, ...h.symbols, ...h.errors, ...h.tracebackPaths]
    for (const tok of POLLUTION_TOKENS) {
      for (const out of allTokens) {
        expect(out.includes(tok)).toBe(false)
      }
    }
  })

  test("h04: ANSI escape codes interleaved — must not break extraction", () => {
    const ANSI = "[31m"
    const RESET = "[0m"
    const text = `Crash in ${ANSI}requests/models.py${RESET} got ${ANSI}TypeError${RESET}`
    expect(extractFiles(text)).toContain("requests/models.py")
    expect(extractErrors(text)).toContain("TypeError")
  })

  test("h05: huge 10MB input — bounded runtime (no regex DoS)", () => {
    const big = "x".repeat(10 * 1024 * 1024)
    const start = Date.now()
    const h = extractIssueHint(big)
    const elapsed = Date.now() - start
    // No throw, fast-ish (we don't pin an exact bound, just that the test
    // returns within the bun default timeout).
    expect(elapsed).toBeLessThan(30_000)
    expect(Array.isArray(h.files)).toBe(true)
  })

  test("h06: long repeats (regex-DoS shape) — no exponential blowup", () => {
    // Pathological backtrack triggers: long runs interspersed with separators.
    const evil = `${"a".repeat(50_000)}/${"b".repeat(50_000)}.py`
    const start = Date.now()
    extractFiles(evil)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5_000)
  })

  test("h07: nested / unbalanced backticks", () => {
    // Triple-fence interleaved with single backticks. Must not throw.
    const text = "```\nfoo `bar` baz\n``` ` `` ``` ``` ```\n"
    expect(() => extractCodeFences(text)).not.toThrow()
    expect(() => extractSymbols(text)).not.toThrow()
  })

  test("h08: Unicode (Korean, RTL, emoji) does not break extraction", () => {
    const text =
      "한글 설명: `prepare_url` 에서 TypeError 발생. ערבית/עברית טקסט. 🚀 emoji test. crash in src/foo.py"
    expect(extractFiles(text)).toContain("src/foo.py")
    expect(extractSymbols(text)).toContain("prepare_url")
    expect(extractErrors(text)).toContain("TypeError")
  })

  test("h09: only whitespace / newlines / tabs", () => {
    expect(extractIssueHint(" \t\n \r\n\t")).toEqual({
      files: [],
      symbols: [],
      errors: [],
      codeFences: [],
      tracebackPaths: [],
    })
  })

  test("h10: input with extremely long line (no newline)", () => {
    const longLine = `crash in path/to/file.py and ${"x".repeat(100_000)} TypeError`
    const start = Date.now()
    const h = extractIssueHint(longLine)
    expect(Date.now() - start).toBeLessThan(10_000)
    expect(h.files).toContain("path/to/file.py")
    expect(h.errors).toContain("TypeError")
  })

  test("h11: path > 200 chars rejected (no crash)", () => {
    const huge = `a/${"x".repeat(500)}.py`
    expect(extractFiles(`crash in ${huge}`)).toEqual([])
  })

  test("h12: identifier > 80 chars in `def` rejected", () => {
    const huge = "x".repeat(200)
    expect(extractSymbols(`def ${huge}():`)).toEqual([])
  })

  test("h13: error name > 60 chars rejected", () => {
    const huge = `${"A".repeat(100)}Error`
    expect(extractErrors(`raises ${huge}`)).toEqual([])
  })

  test("h14: code fence > 4 KiB capped, not dropped", () => {
    const body = "x".repeat(8 * 1024)
    const text = `\`\`\`\n${body}\n\`\`\``
    const fences = extractCodeFences(text)
    expect(fences.length).toBe(1)
    expect((fences[0] ?? "").length).toBeLessThanOrEqual(4 * 1024)
  })

  test("h15: malformed triple-fence (no closing) does not crash", () => {
    expect(() => extractCodeFences("```python\nno close ever")).not.toThrow()
    expect(extractCodeFences("```python\nno close ever")).toEqual([])
  })

  test("h16: malformed Python traceback (no quotes) does not throw", () => {
    expect(() => extractTracebackPaths(`File a/b.py, line 1`)).not.toThrow()
    expect(extractTracebackPaths(`File a/b.py, line 1`)).toEqual([])
  })

  test("h17: malformed TS stack (no parens) does not throw", () => {
    expect(() => extractTracebackPaths("at handler src/foo.ts:42:7")).not.toThrow()
  })

  test("h18: exactOptionalPropertyTypes — all five fields ALWAYS present (never undefined)", () => {
    // Tests that EMPTY_HINT shape is what extractors return on empty input.
    const h = extractIssueHint("")
    expect(h.files).toBeDefined()
    expect(h.symbols).toBeDefined()
    expect(h.errors).toBeDefined()
    expect(h.codeFences).toBeDefined()
    expect(h.tracebackPaths).toBeDefined()
    // Every field MUST be a (possibly empty) array, never undefined.
    expect(Array.isArray(h.files)).toBe(true)
    expect(Array.isArray(h.symbols)).toBe(true)
    expect(Array.isArray(h.errors)).toBe(true)
    expect(Array.isArray(h.codeFences)).toBe(true)
    expect(Array.isArray(h.tracebackPaths)).toBe(true)
  })

  test("h19: many duplicates collapse to single entry (no quadratic blowup)", () => {
    const text = Array.from({ length: 5000 }, () => "a/b.py").join(" ")
    const start = Date.now()
    const out = extractFiles(text)
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(out).toEqual(["a/b.py"])
  })

  test("h20: backtick-fenced empty / single-char rejected", () => {
    expect(extractSymbols("`` `x` `y`")).toEqual([]) // empty + 1-char both rejected
  })

  test("h21: regex lastIndex state isolation (consecutive calls deterministic)", () => {
    const text = "a/b.py and c/d.py"
    const a = extractFiles(text)
    const b = extractFiles(text)
    const c = extractFiles(text)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  test("h22: input with NUL byte not break extraction", () => {
    const text = "a/b.py  then TypeError"
    expect(() => extractIssueHint(text)).not.toThrow()
    const h = extractIssueHint(text)
    expect(h.errors).toContain("TypeError")
  })

  test("h23: hint composer always finishes — even on adversarial input", () => {
    const evil =
      "`__proto__` `constructor` `prototype` def __proto__() class prototype " +
      "raise __proto__Error\n```\n" +
      "x".repeat(100_000) +
      "\n```"
    const h = extractIssueHint(evil)
    const out = composeIssueHint(h)
    // No prototype-pollution token in the rendered output.
    for (const tok of POLLUTION_TOKENS) {
      expect(out.includes(tok)).toBe(false)
    }
  })

  test("h24: object-shape sanity — returned object is a plain shape (own keys only)", () => {
    const h = extractIssueHint("def foo():")
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype)
    expect(Object.keys(h).sort()).toEqual([
      "codeFences",
      "errors",
      "files",
      "symbols",
      "tracebackPaths",
    ])
  })

  test("h25: sorted/unique invariant across all extractors", () => {
    const text =
      "z/a.py b/a.py a/a.py `zfoo` `afoo` `mfoo` ZError AError MError\n" +
      `File "z.py", line 1\nFile "a.py", line 1`
    const h = extractIssueHint(text)
    // files / symbols / errors / tracebackPaths are sorted unique
    const isSortedUnique = (arr: readonly string[]): boolean => {
      const sorted = [...arr].sort()
      return arr.every((v, i) => v === sorted[i]) && new Set(arr).size === arr.length
    }
    expect(isSortedUnique(h.files)).toBe(true)
    expect(isSortedUnique(h.symbols)).toBe(true)
    expect(isSortedUnique(h.errors)).toBe(true)
    expect(isSortedUnique(h.tracebackPaths)).toBe(true)
  })

  test("h26: composer on adversarial bombing input — empty rendered output if nothing real", () => {
    // Input is only protocol-style noise — no real signal should mean empty.
    const noise = "______ ////// .... :::: ;;;; ((((( {{{{{"
    const h = extractIssueHint(noise)
    expect(composeIssueHint(h)).toBe("")
  })

  test("h27: huge multi-MB compose still produces bounded output", () => {
    const big = `crash in a/b.py raised TypeError ${"x".repeat(2_000_000)}`
    const h = extractIssueHint(big)
    const out = composeIssueHint(h)
    // Bounded output: a handful of lines, NOT the 2MB input.
    expect(out.length).toBeLessThan(10_000)
  })
})
