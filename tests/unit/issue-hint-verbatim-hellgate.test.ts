/**
 * Hellgate: adversarial inputs against the VERBATIM-EVIDENCE upgrade.
 *
 * Coverage axes (additional to the original `issue-hint-hellgate`):
 *   - giant code fences (10MB) — capped via head+tail, never crashed
 *   - broken tracebacks (header without close) — gracefully bounded
 *   - multiple distinct tracebacks
 *   - nested backticks inside fence body
 *   - ANSI escape codes interleaved
 *   - empty fence body
 *   - malformed `#abc` (digit-less) — NOT a ref
 *   - prototype pollution surfaces (`__proto__.py`, `#__proto__`)
 *   - Unicode in fence body / refs
 *   - exactOptionalPropertyTypes contract: `expectedActual` absent when not
 *     opted in OR when extraction finds nothing
 */
import { describe, expect, test } from "bun:test"
import {
  composeIssueHint,
  extractCodeFences,
  extractExpectedActual,
  extractIssueHint,
  extractRefs,
  extractTracebacks,
} from "../../src/agent/issue-hint"

describe("issue-hint verbatim-evidence hellgate (20+ cases)", () => {
  test("v01: 10 MB code fence body — cap holds, no crash", () => {
    const huge = "x".repeat(10 * 1024 * 1024)
    const text = `\`\`\`\n${huge}\n\`\`\``
    const start = Date.now()
    const out = extractCodeFences(text)
    expect(Date.now() - start).toBeLessThan(15_000)
    expect(out.length).toBe(1)
    expect((out[0] ?? "").length).toBeLessThanOrEqual(4 * 1024)
  })

  test("v02: code fence head+tail compression preserves final lines", () => {
    const lines: string[] = []
    for (let i = 0; i < 1000; i++) lines.push(`line-${i}-with-some-padding`)
    lines.push("END_MARKER_FINAL_LINE")
    const body = lines.join("\n")
    const text = `\`\`\`python\n${body}\n\`\`\``
    const out = extractCodeFences(text)
    expect(out.length).toBe(1)
    const got = out[0] ?? ""
    expect(got.length).toBeLessThanOrEqual(4 * 1024)
    expect(got).toContain("END_MARKER_FINAL_LINE")
    expect(got).toContain("…")
  })

  test("v03: empty fence body dropped", () => {
    expect(extractCodeFences("```python\n\n```")).toEqual([])
    expect(extractCodeFences("```\n\t  \n```")).toEqual([])
  })

  test("v04: nested backticks inside fence body do NOT terminate early", () => {
    // ` single backticks inside the body are fine; only triple-backtick closes
    const body = "this has `single` and ``double`` backticks inside"
    const text = `\`\`\`\n${body}\n\`\`\``
    const out = extractCodeFences(text)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(body)
  })

  test("v05: broken traceback (header but no body) — gracefully bounded", () => {
    expect(() => extractTracebacks("Traceback (most recent call last):")).not.toThrow()
  })

  test("v06: multiple distinct tracebacks captured in order", () => {
    const tb1 = 'Traceback (most recent call last):\n  File "a.py", line 1\nTypeError: A'
    const tb2 = 'Traceback (most recent call last):\n  File "b.py", line 2\nValueError: B'
    const out = extractTracebacks(`${tb1}\n\n${tb2}\n\n`)
    expect(out).toEqual([tb1, tb2])
  })

  test("v07: extremely long traceback compressed with exception line preserved", () => {
    const frames: string[] = []
    for (let i = 0; i < 200; i++) frames.push(`  File "deep.py", line ${i + 1}, in fn${i}`)
    const block = `Traceback (most recent call last):\n${frames.join("\n")}\nKEY_EXCEPTION_MARKER: pin`
    const out = extractTracebacks(block)
    expect(out.length).toBe(1)
    const compressed = out[0] ?? ""
    expect(compressed.length).toBeLessThanOrEqual(4 * 1024)
    expect(compressed).toContain("KEY_EXCEPTION_MARKER")
  })

  test("v08: ANSI escape codes in fence body preserved verbatim (no strip)", () => {
    // Per extract-code.ts docstring: fence bodies are verbatim including ANSI.
    const ESC = ""
    const body = `${ESC}[31mcolored${ESC}[0m`
    const text = `\`\`\`\n${body}\n\`\`\``
    const out = extractCodeFences(text)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(body)
  })

  test("v09: ANSI escape codes in traceback STRIPPED before scan", () => {
    const ESC = ""
    const text = `${ESC}[31mTraceback (most recent call last):\n  File "x.py", line 1\nTypeError${ESC}[0m`
    const out = extractTracebacks(text)
    expect(out.length).toBe(1)
    expect((out[0] ?? "").includes(ESC)).toBe(false)
  })

  test("v10: malformed #abc (non-digit) NOT a ref", () => {
    expect(extractRefs("see #abc and #FF0000")).toEqual([])
  })

  test("v11: prototype-pollution surface — #__proto__ NOT a ref", () => {
    expect(extractRefs("#__proto__")).toEqual([])
  })

  test("v12: prototype-pollution in path forms rejected", () => {
    const h = extractIssueHint("see __proto__.py and __proto__/foo.py")
    for (const f of h.files) {
      expect(f.startsWith("__proto__")).toBe(false)
    }
  })

  test("v13: Unicode in fence body preserved (verbatim)", () => {
    const body = "한글 주석\nimport requests\nrequests.get('🚀')"
    const text = `\`\`\`python\n${body}\n\`\`\``
    const out = extractCodeFences(text)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(body)
  })

  test("v14: 10K-line input scanned in bounded time (no DoS)", () => {
    const lines: string[] = []
    for (let i = 0; i < 10_000; i++) lines.push(`#${i + 1} mentions src/foo${i}.py and TypeError`)
    const text = lines.join("\n")
    const start = Date.now()
    const h = extractIssueHint(text)
    expect(Date.now() - start).toBeLessThan(10_000)
    expect(h.refs.length).toBeGreaterThan(0)
  })

  test("v15: expectedActual OMITTED when not opted-in", () => {
    const h = extractIssueHint("We expected 1. Got 2.")
    expect("expectedActual" in h).toBe(false)
  })

  test("v16: expectedActual OMITTED when opted-in but no matches found", () => {
    const h = extractIssueHint("Plain text with no markers.", { withExpectedActual: true })
    // No matches => property OMITTED (exactOptionalPropertyTypes contract)
    expect("expectedActual" in h).toBe(false)
  })

  test("v17: expectedActual PRESENT when opted-in and matches found", () => {
    const h = extractIssueHint("We expected 1. Got 2.", { withExpectedActual: true })
    expect(h.expectedActual).toBeDefined()
    expect((h.expectedActual ?? []).length).toBeGreaterThan(0)
  })

  test("v18: extractIssueHint returns 7 mandatory keys (+ optional E/A)", () => {
    const h = extractIssueHint("see a.py")
    expect(Object.keys(h).sort()).toEqual([
      "codeFences",
      "errors",
      "files",
      "refs",
      "symbols",
      "tracebackPaths",
      "tracebacks",
    ])
  })

  test("v19: real fixture shape (requests-5414 evidence) — all axes present", () => {
    const text = [
      "Getting http://.example.com raises UnicodeError",
      "Attempting to get `http://.example.com` results in a `UnicodeError`.",
      "See PR #774 for context.",
      "",
      "```python",
      "import requests",
      'requests.get("http://.example.com")',
      "```",
      "",
      "Traceback (most recent call last):",
      '  File "requests/models.py", line 401, in prepare_url',
      "    raise InvalidURL('URL has an invalid label.')",
      "UnicodeError: encoding with 'idna' codec failed",
    ].join("\n")
    const h = extractIssueHint(text)
    // VERBATIM code fence body
    expect(h.codeFences.length).toBe(1)
    expect(h.codeFences[0]).toContain('requests.get("http://.example.com")')
    // VERBATIM traceback block
    expect(h.tracebacks.length).toBe(1)
    expect(h.tracebacks[0] ?? "").toContain("UnicodeError: encoding with 'idna' codec failed")
    // Ref
    expect(h.refs).toContain("#774")
    // File (slash form)
    expect(h.files).toContain("requests/models.py")
    // Error with message body
    expect(h.errors).toContain("UnicodeError")
  })

  test("v20: composeIssueHint output bounded (under 100KB even with full evidence)", () => {
    const big = "x".repeat(50_000)
    const text = `${big}\n\`\`\`\n${big}\n\`\`\`\n\nTraceback (most recent call last):\n${big}\nTypeError: pinpoint`
    const h = extractIssueHint(text)
    const out = composeIssueHint(h)
    // Sum of capped sections + headers. Each verbatim cap is 4KB, so ~10KB
    // is the realistic ceiling; allow 100KB headroom.
    expect(out.length).toBeLessThan(100_000)
  })

  test("v21: composeIssueHint with empty hint → empty string (sentinel)", () => {
    const h = extractIssueHint("")
    expect(composeIssueHint(h)).toBe("")
  })

  test("v22: extractExpectedActual function used directly", () => {
    // Direct entry — bench wiring uses options object, but the function is
    // also callable standalone.
    expect(extractExpectedActual("")).toEqual([])
    const out = extractExpectedActual("We expected the result.")
    expect(out.some((s) => s.includes("expected the result"))).toBe(true)
  })

  test("v23: prototype-pollution defense across all extractors", () => {
    const hostile =
      "__proto__ constructor prototype " +
      "__proto__/x.py constructor/y.py " +
      "`__proto__` `constructor` `prototype`"
    const h = extractIssueHint(hostile)
    const all = [...h.files, ...h.symbols, ...h.errors, ...h.refs, ...h.tracebackPaths]
    for (const v of all) {
      expect(["__proto__", "constructor", "prototype"].some((tok) => v.startsWith(tok))).toBe(false)
    }
  })

  test("v24: composeIssueHint adversarial input — no prototype-pollution token in output", () => {
    const evil =
      "`__proto__` `constructor` `prototype` def __proto__() class prototype " +
      "raise __proto__Error\n```\n" +
      "x".repeat(100_000) +
      "\n```"
    const h = extractIssueHint(evil)
    const out = composeIssueHint(h)
    // The composer doesn't sanitize again; it relies on extractors. But the
    // assembled output (excluding the verbatim fence body, which is a legit
    // code-region) MUST not surface pollution as identifiers.
    expect(out).not.toContain("- `__proto__`")
    expect(out).not.toContain("- `constructor`")
  })

  test("v25: extractIssueHint idempotent across repeated calls (regex lastIndex reset)", () => {
    const text = "see foo.py and #774"
    const a = extractIssueHint(text)
    const b = extractIssueHint(text)
    const c = extractIssueHint(text)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  test("v26: HTML comments are stripped before extraction", () => {
    const text = [
      "<!-- hidden/path.py should never surface -->",
      "<!-- ```python",
      "import hidden",
      "hidden.run()",
      "``` -->",
      "Visible path is pkg/real.py",
      "```python",
      "import visible",
      "visible.run()",
      "```",
    ].join("\n")
    const h = extractIssueHint(text)
    expect(h.files).not.toContain("hidden/path.py")
    expect(h.files).toContain("pkg/real.py")
    expect(h.codeFences).toEqual(["import visible\nvisible.run()"])
  })
})
