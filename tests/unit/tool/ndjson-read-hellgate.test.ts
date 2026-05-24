/**
 * Hellgate — `ndjson_read` tool + pure `parseNdjson` (ADR-0133).
 *
 * Seal:
 *   A. parseNdjson pure   — 5 cases (happy, malformed, blank, CRLF, empty)
 *   B. ndjson_read tool   — 7 cases (metadata, happy, missing, caps,
 *                                    malformed, traversal, empty)
 *
 * No mocks for FS — uses a real tmpdir.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ndjsonReadTool, parseNdjson } from "@/tool/document"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

let workDir = ""

const ctx = (signal?: AbortSignal, cwdOverride?: string): ToolContext => ({
  cwd: cwdOverride ?? workDir,
  signal: signal ?? new AbortController().signal,
})

const collect = async (input: unknown, c: ToolContext = ctx()): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of ndjsonReadTool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "ndjson-read-hellgate-"))
  await writeFile(
    path.join(workDir, "valid.ndjson"),
    '{"a":1}\n{"b":2}\n{"c":3}\n',
  )
  await writeFile(
    path.join(workDir, "mixed.ndjson"),
    '{"ok":true}\n{not json\n{"second":"ok"}\n',
  )
  await writeFile(
    path.join(workDir, "many.ndjson"),
    `${Array.from({ length: 50 }, (_, i) => JSON.stringify({ idx: i })).join("\n")}\n`,
  )
  await writeFile(path.join(workDir, "empty.ndjson"), "")
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* A. parseNdjson pure                                                 */
/* ------------------------------------------------------------------ */

describe("A. parseNdjson pure", () => {
  test("1. 3 valid JSON lines → 3 entries with value, errorCount=0", () => {
    const r = parseNdjson('{"a":1}\n{"b":2}\n{"c":3}\n')
    expect(r.lines.length).toBe(3)
    expect(r.errorCount).toBe(0)
    expect(r.lines[0]?.value).toEqual({ a: 1 })
    expect(r.lines[2]?.lineNumber).toBe(3)
    // exactOptional: error OMITTED when successful
    expect(r.lines[0]?.error).toBeUndefined()
    expect("error" in (r.lines[0] ?? {})).toBe(false)
  })
  test("2. one malformed line → value:null + error; errorCount=1", () => {
    const r = parseNdjson('{"ok":1}\n{bad\n{"after":2}\n')
    expect(r.lines.length).toBe(3)
    expect(r.errorCount).toBe(1)
    expect(r.lines[1]?.value).toBe(null)
    expect(r.lines[1]?.error).toBeDefined()
    // following good line still parsed
    expect(r.lines[2]?.value).toEqual({ after: 2 })
  })
  test("3. blank/whitespace-only lines skipped", () => {
    const r = parseNdjson('{"a":1}\n\n   \n{"b":2}\n')
    expect(r.lines.length).toBe(2)
    expect(r.lines[0]?.lineNumber).toBe(1)
    expect(r.lines[1]?.lineNumber).toBe(4)
    expect(r.errorCount).toBe(0)
  })
  test("4. mixed CRLF/LF terminators handled", () => {
    const r = parseNdjson('{"a":1}\r\n{"b":2}\n{"c":3}\r\n')
    expect(r.lines.length).toBe(3)
    expect(r.errorCount).toBe(0)
    expect(r.lines[0]?.value).toEqual({ a: 1 })
    expect(r.lines[2]?.value).toEqual({ c: 3 })
  })
  test("5. empty input → empty lines + errorCount=0", () => {
    const r = parseNdjson("")
    expect(r.lines.length).toBe(0)
    expect(r.errorCount).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* B. ndjson_read tool                                                 */
/* ------------------------------------------------------------------ */

describe("B. ndjson_read tool", () => {
  test("6. metadata (name / isReadOnly / isConcurrencySafe)", () => {
    expect(ndjsonReadTool.name).toBe("ndjson_read")
    expect(ndjsonReadTool.isReadOnly()).toBe(true)
    expect(ndjsonReadTool.isConcurrencySafe({ path: "x.ndjson" })).toBe(true)
  })
  test("7. happy: real file → ok:true, lines listed", async () => {
    const r = await collect({ path: "valid.ndjson" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("NDJSON: valid.ndjson")
    expect(r.output).toContain("3 lines, 0 parse errors")
    expect(r.output).toContain('L1: {"a":1}')
    expect(r.output).toContain('L3: {"c":3}')
  })
  test("8. missing file → ok:false", async () => {
    const r = await collect({ path: "does-not-exist.ndjson" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not found|ENOENT/i)
    expect(r.failure?.mode).toBe("not_found")
  })
  test("9. maxLines cap → output limited", async () => {
    const r = await collect({ path: "many.ndjson", maxLines: 10 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Lines (showing 10)")
    expect(r.output).toContain("more lines")
    expect(r.output).toContain('"idx":9')
    expect(r.output).not.toContain('"idx":10')
  })
  test("10. malformed lines show <ERROR: ...>", async () => {
    const r = await collect({ path: "mixed.ndjson" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("<ERROR:")
    expect(r.output).toContain("1 parse errors")
    // the good lines on either side are still rendered
    expect(r.output).toContain('"ok":true')
    expect(r.output).toContain('"second":"ok"')
  })
  test("11. path traversal `..` → ok:false", async () => {
    const r = await collect({ path: "../../../etc/passwd" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/outside cwd|not found|symlink/i)
  })
  test("12. empty file → ok:true `0 lines`", async () => {
    const r = await collect({ path: "empty.ndjson" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("0 lines")
  })
})
