/**
 * `extractCodeFences` / `extractTracebackPaths` — code-region signals.
 *
 * Code fences capped at 4 KiB each; empty bodies dropped. Traceback paths
 * cover Python `File "x", line N` and TS/JS `at frame (path:line:col)`.
 */
import { describe, expect, test } from "bun:test"
import {
  extractCodeFences,
  extractTracebackPaths,
} from "../../../src/agent/issue-hint/extract-code"

describe("extractCodeFences — triple-backtick blocks", () => {
  test("empty input → []", () => {
    expect(extractCodeFences("")).toEqual([])
  })

  test("simple language-tagged fence body extracted", () => {
    const text = "Before\n```python\nimport requests\nrequests.get('x')\n```\nAfter"
    expect(extractCodeFences(text)).toEqual(["import requests\nrequests.get('x')"])
  })

  test("untagged fence (no language) extracted", () => {
    const text = "```\nplain code\n```"
    expect(extractCodeFences(text)).toEqual(["plain code"])
  })

  test("empty (whitespace-only) fence body REJECTED", () => {
    expect(extractCodeFences("```python\n\n\n```")).toEqual([])
    expect(extractCodeFences("```\n   \n```")).toEqual([])
  })

  test("multiple distinct fences preserved in authoring order", () => {
    const text = "```\nA\n```\n\n```python\nB\n```"
    expect(extractCodeFences(text)).toEqual(["A", "B"])
  })

  test("duplicate fence bodies deduped (same body twice → kept once)", () => {
    const text = "```\nA\n```\n```\nA\n```"
    expect(extractCodeFences(text)).toEqual(["A"])
  })

  test("fence body capped at 4 KiB via head+tail compression", () => {
    const big = "x".repeat(8 * 1024)
    const text = `\`\`\`\n${big}\n\`\`\``
    const out = extractCodeFences(text)
    expect(out.length).toBe(1)
    // Each capped to 4 KiB
    expect((out[0] ?? "").length).toBeLessThanOrEqual(4 * 1024)
  })

  test("fence body head+tail compression preserves the last lines (exception-line policy)", () => {
    // Build many short lines so the tail-collection finds non-empty lines
    // each well under the cap. Total body > 4KB triggers compression; the
    // FINAL line carries the unique marker that MUST survive.
    const filler: string[] = []
    for (let i = 0; i < 1000; i++) filler.push(`filler ${i} some padding XYZ`)
    const finalLine = "RAISES UNIQUE_MARKER_HERE: this is the final line"
    const body = `${filler.join("\n")}\n${finalLine}`
    const text = `\`\`\`\n${body}\n\`\`\``
    const out = extractCodeFences(text)
    expect(out.length).toBe(1)
    const got = out[0] ?? ""
    // Final line preserved (exception-line policy)
    expect(got).toContain("UNIQUE_MARKER_HERE")
    // Ellipsis marker present (proves compression fired)
    expect(got).toContain("…")
    // Total under cap
    expect(got.length).toBeLessThanOrEqual(4 * 1024)
  })

  test("regex state isolation across calls", () => {
    const text = "```py\nfoo\n```"
    expect(extractCodeFences(text)).toEqual(["foo"])
    expect(extractCodeFences(text)).toEqual(["foo"])
  })
})

describe("extractTracebackPaths — file:line from tracebacks", () => {
  test("empty input → []", () => {
    expect(extractTracebackPaths("")).toEqual([])
  })

  test("Python File-line traceback captured", () => {
    const text = `File "requests/models.py", line 401, in prepare_url`
    expect(extractTracebackPaths(text)).toEqual(["requests/models.py:401"])
  })

  test("multi-frame Python traceback all captured + sorted", () => {
    const text = `
      File "a/b.py", line 10, in foo
      File "a/c.py", line 20, in bar
      File "a/b.py", line 30, in baz
    `
    expect(extractTracebackPaths(text)).toEqual(["a/b.py:10", "a/b.py:30", "a/c.py:20"])
  })

  test("TS/JS stack frame: 'at frame (path:line:col)' → path:line", () => {
    const text = "    at handler (src/agent/loop.ts:42:7)"
    expect(extractTracebackPaths(text)).toEqual(["src/agent/loop.ts:42"])
  })

  test("TS/JS without col still captured", () => {
    const text = "    at handler (src/agent/loop.ts:42)"
    expect(extractTracebackPaths(text)).toEqual(["src/agent/loop.ts:42"])
  })

  test("malformed traceback (no line number) NOT captured", () => {
    expect(extractTracebackPaths(`File "x.py"`)).toEqual([])
  })

  test("path longer than 200 chars REJECTED", () => {
    const big = "a/".repeat(110) // > 200 chars
    const text = `File "${big}foo.py", line 1, in foo`
    expect(extractTracebackPaths(text)).toEqual([])
  })

  test("output is sorted-unique deterministically", () => {
    const text = `File "a.py", line 1\nFile "a.py", line 1\nFile "a.py", line 1`
    expect(extractTracebackPaths(text)).toEqual(["a.py:1"])
  })

  test("regex state isolation", () => {
    const text = `File "x.py", line 1`
    expect(extractTracebackPaths(text)).toEqual(["x.py:1"])
    expect(extractTracebackPaths(text)).toEqual(["x.py:1"])
  })
})
