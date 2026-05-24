/**
 * Hellgate — `csv_read` tool + pure `parseCsv` (ADR-0133).
 *
 * Seal:
 *   A. parseCsv pure   — 8 cases (RFC-4180 corners + diagnostics)
 *   B. csv_read tool   — 8 cases (metadata, happy, missing, caps, traversal)
 *
 * No mocks for FS — uses a real tmpdir.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { csvReadTool, parseCsv } from "@/tool/document"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

let workDir = ""

const ctx = (signal?: AbortSignal, cwdOverride?: string): ToolContext => ({
  cwd: cwdOverride ?? workDir,
  signal: signal ?? new AbortController().signal,
})

const collect = async (input: unknown, c: ToolContext = ctx()): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of csvReadTool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "csv-read-hellgate-"))
  await writeFile(
    path.join(workDir, "simple.csv"),
    "name,age,city,country\nAlice,30,NYC,US\nBob,25,LA,US\nCarol,40,Chicago,US\n",
  )
  await writeFile(path.join(workDir, "data.tsv"), "name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tLA\n")
  await writeFile(
    path.join(workDir, "many.csv"),
    `name,age\n${Array.from({ length: 50 }, (_, i) => `R${i},${i}`).join("\n")}\n`,
  )
  await writeFile(path.join(workDir, "noheader.csv"), "Alice,30\nBob,25\nCarol,40\n")
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* A. parseCsv pure                                                    */
/* ------------------------------------------------------------------ */

describe("A. parseCsv pure", () => {
  test("1. simple 3-row CSV → 1 header + 3 rows", () => {
    const r = parseCsv("name,age,city\nA,1,X\nB,2,Y\nC,3,Z\n")
    expect(r.headers).toEqual(["name", "age", "city"])
    expect(r.rows.length).toBe(3)
    expect(r.rows[0]?.cells.map((c) => c.raw)).toEqual(["A", "1", "X"])
    expect(r.rows[0]?.cells[0]?.column).toBe(1)
    expect(r.diagnostics.length).toBe(0)
  })
  test("2. TSV (delimiter=\\t) splits correctly", () => {
    const r = parseCsv("a\tb\tc\n1\t2\t3\n", { delimiter: "\t" })
    expect(r.headers).toEqual(["a", "b", "c"])
    expect(r.rows[0]?.cells.map((c) => c.raw)).toEqual(["1", "2", "3"])
  })
  test("3. quoted comma in cell → preserved as one cell", () => {
    const r = parseCsv('a,b\n"hello, world",ok\n')
    expect(r.rows[0]?.cells.map((c) => c.raw)).toEqual(["hello, world", "ok"])
    expect(r.diagnostics.length).toBe(0)
  })
  test('4. escaped quote "" inside quoted cell → single " in output', () => {
    const r = parseCsv('a,b\n"he said ""hi""",ok\n')
    expect(r.rows[0]?.cells[0]?.raw).toBe('he said "hi"')
    expect(r.rows[0]?.cells[1]?.raw).toBe("ok")
  })
  test("5. CRLF terminators handled", () => {
    const r = parseCsv("a,b\r\n1,2\r\n3,4\r\n")
    expect(r.headers).toEqual(["a", "b"])
    expect(r.rows.length).toBe(2)
    expect(r.rows[0]?.cells.map((c) => c.raw)).toEqual(["1", "2"])
  })
  test("6. unterminated quote → diagnostic + best-effort row included", () => {
    const r = parseCsv('a,b\n"unterminated,still going\n')
    const diag = r.diagnostics.find((d) => d.kind === "unterminated-quote")
    expect(diag).toBeDefined()
    // best-effort: the partial cell is still surfaced (no data loss)
    expect(r.rows.length).toBeGreaterThanOrEqual(1)
  })
  test("7. ragged row → diagnostic + row included", () => {
    const r = parseCsv("a,b,c\n1,2,3\n4,5\n6,7,8,9\n")
    const ragged = r.diagnostics.filter((d) => d.kind === "ragged-row")
    expect(ragged.length).toBe(2) // row 2 and row 3 are ragged
    expect(r.rows.length).toBe(3) // all still emitted
    expect(r.rows[1]?.cells.length).toBe(2)
    expect(r.rows[2]?.cells.length).toBe(4)
  })
  test("8. empty input → empty result + diagnostic", () => {
    const r = parseCsv("")
    expect(r.headers).toBe(null)
    expect(r.rows.length).toBe(0)
    expect(r.diagnostics.length).toBe(1)
    expect(r.diagnostics[0]?.kind).toBe("empty-input")
  })
})

/* ------------------------------------------------------------------ */
/* B. csv_read tool                                                    */
/* ------------------------------------------------------------------ */

describe("B. csv_read tool", () => {
  test("9. metadata (name / isReadOnly / isConcurrencySafe)", () => {
    expect(csvReadTool.name).toBe("csv_read")
    expect(csvReadTool.isReadOnly()).toBe(true)
    expect(csvReadTool.isConcurrencySafe({ path: "x.csv" })).toBe(true)
  })
  test("10. happy: real tmpdir CSV → ok:true, output contains headers + rows", async () => {
    const r = await collect({ path: "simple.csv" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("CSV: simple.csv")
    expect(r.output).toContain("Headers (4): name, age, city, country")
    expect(r.output).toContain("Alice")
    expect(r.output).toContain("Carol")
    expect(r.output).toContain("3 rows total")
  })
  test("11. missing file → ok:false", async () => {
    const r = await collect({ path: "does-not-exist.csv" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not found|ENOENT/i)
    expect(r.failure?.mode).toBe("not_found")
  })
  test("12. maxRows cap → output limited", async () => {
    const r = await collect({ path: "many.csv", maxRows: 5 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Rows (showing 5)")
    expect(r.output).toContain("more rows")
    // Should contain R0..R4 but not R5
    expect(r.output).toContain("R4")
    expect(r.output).not.toContain('"R5"')
  })
  test("13. noHeader=true → no Headers: line", async () => {
    const r = await collect({ path: "noheader.csv", noHeader: true })
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("Headers (")
    // All 3 rows are data rows.
    expect(r.output).toContain("3 rows total")
  })
  test("14. delimiter=\\t → TSV parsed", async () => {
    const r = await collect({ path: "data.tsv", delimiter: "\t" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Headers (3): name, age, city")
    expect(r.output).toContain("Alice")
  })
  test("15. path traversal `..` → ok:false", async () => {
    const r = await collect({ path: "../../../etc/passwd" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/outside cwd|not found|symlink/i)
  })
  test("16. empty path string → ok:false invalid input", async () => {
    const r = await collect({ path: "" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
})
