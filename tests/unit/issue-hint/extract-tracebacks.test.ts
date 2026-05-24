/**
 * `extractTracebacks` — verbatim Python traceback block extraction.
 *
 * Contract:
 *   - block starts at literal `Traceback (most recent call last):`
 *   - body extends to next blank line OR end of input
 *   - returned VERBATIM (no reformatting)
 *   - per-block 4 KiB cap with head + tail compression (last 10 non-empty
 *     lines preserved — the exception line always sits at the end)
 *   - duplicates deduped on the verbatim body
 *   - order preserved (authoring order; first occurrence wins)
 */
import { describe, expect, test } from "bun:test"
import { extractTracebacks } from "../../../src/agent/issue-hint/extract-tracebacks"

describe("extractTracebacks — verbatim Python traceback blocks", () => {
  test("empty input → []", () => {
    expect(extractTracebacks("")).toEqual([])
    expect(extractTracebacks(undefined as unknown as string)).toEqual([])
  })

  test("simple Python traceback captured verbatim", () => {
    const block =
      'Traceback (most recent call last):\n  File "a.py", line 1, in foo\n    bar()\nTypeError: bad'
    const text = `intro\n\n${block}\n\nafter`
    const out = extractTracebacks(text)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(block)
  })

  test("missing terminator (end of input) — captured", () => {
    const block = 'Traceback (most recent call last):\n  File "a.py", line 1\nTypeError: at the end'
    const out = extractTracebacks(block)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(block)
  })

  test("multiple distinct tracebacks captured in authoring order", () => {
    const tb1 = 'Traceback (most recent call last):\n  File "a.py", line 1\nTypeError: first'
    const tb2 = 'Traceback (most recent call last):\n  File "b.py", line 2\nValueError: second'
    const text = `${tb1}\n\nmidtext\n\n${tb2}`
    const out = extractTracebacks(text)
    expect(out).toEqual([tb1, tb2])
  })

  test("duplicate traceback bodies deduped (kept once)", () => {
    const tb = 'Traceback (most recent call last):\n  File "a.py", line 1\nTypeError: x'
    const text = `${tb}\n\n${tb}`
    expect(extractTracebacks(text)).toEqual([tb])
  })

  test("over-4KB block compressed with head + ellipsis + tail", () => {
    // Build a large block with a unique final exception line.
    const filler = Array.from(
      { length: 800 },
      (_, i) => `  File "f.py", line ${i + 1}, in fn${i}`,
    ).join("\n")
    const block = `Traceback (most recent call last):\n${filler}\nUniqueFinalError: pinpoint me`
    expect(block.length).toBeGreaterThan(4 * 1024)
    const out = extractTracebacks(block)
    expect(out.length).toBe(1)
    const compressed = out[0] ?? ""
    expect(compressed.length).toBeLessThanOrEqual(4 * 1024)
    // Header preserved
    expect(compressed.startsWith("Traceback (most recent call last):")).toBe(true)
    // Final exception line preserved
    expect(compressed).toContain("UniqueFinalError: pinpoint me")
    // Ellipsis marker present
    expect(compressed).toContain("…")
  })

  test("no Python traceback header → []", () => {
    // JS-style stack alone does not trigger Python-block extraction
    expect(
      extractTracebacks(
        "Error: bad\n    at handler (src/foo.ts:42:7)\n    at next (src/bar.ts:1:1)",
      ),
    ).toEqual([])
  })

  test("ANSI escape codes stripped before scanning (real ESC bytes)", () => {
    const ESC = ""
    const text = `${ESC}[31mTraceback (most recent call last):\n  File "x.py", line 1\nTypeError${ESC}[0m`
    const out = extractTracebacks(text)
    // ANSI strip means the body extracted will be without escape codes
    expect(out.length).toBe(1)
    expect((out[0] ?? "").includes(ESC)).toBe(false)
  })

  test("regex state isolation across calls", () => {
    const block = 'Traceback (most recent call last):\n  File "x.py", line 1\nTypeError'
    expect(extractTracebacks(block)).toEqual([block])
    expect(extractTracebacks(block)).toEqual([block])
  })

  test("real SWE-bench-shape Python traceback", () => {
    const text = [
      "When running:",
      "",
      "Traceback (most recent call last):",
      '  File "requests/models.py", line 401, in prepare_url',
      "    host = self._get_idna_encoded_host(host)",
      '  File "requests/models.py", line 384, in _get_idna_encoded_host',
      "    return host.encode('idna').decode('utf-8')",
      "UnicodeError: encoding with 'idna' codec failed",
      "",
      "End of report.",
    ].join("\n")
    const out = extractTracebacks(text)
    expect(out.length).toBe(1)
    const block = out[0] ?? ""
    expect(block.startsWith("Traceback (most recent call last):")).toBe(true)
    expect(block).toContain("requests/models.py")
    expect(block).toContain("UnicodeError: encoding with 'idna' codec failed")
    // Block ENDS at blank line — "End of report." NOT included
    expect(block.includes("End of report.")).toBe(false)
  })
})
