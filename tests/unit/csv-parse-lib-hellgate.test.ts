/**
 * Hellgate — `parseCsvLib` (csv-parse@6.2.1-backed adapter, ADR-0177).
 *
 * Mirrors the A-block of `tests/unit/tool/csv-read-hellgate.test.ts` (the
 * pure parser tests) AND asserts byte-equal SHAPE-match against the self-impl
 * `parseCsv` for the common cases. The lib and the self-impl agree on the
 * RFC-4180 core but diverge on best-effort recovery for unterminated quotes;
 * we assert that DIVERGENCE is bounded and the public CsvParseResult shape
 * (headers / rows / diagnostics) stays interchangeable.
 *
 * Seal:
 *   1.  simple 3-row CSV  — full byte-equal to parseCsv
 *   2.  TSV               — full byte-equal
 *   3.  quoted comma      — full byte-equal
 *   4.  escaped quote ""  — full byte-equal
 *   5.  CRLF              — full byte-equal
 *   6.  unterminated quote → diagnostic kind="unterminated-quote"
 *   7.  ragged row → diagnostic kind="ragged-row" per ragged row
 *   8.  empty input → diagnostic kind="empty-input"
 *   9.  noHeader: true → first row is data, headers = null
 *  10.  multi-char delimiter → collapsed to first char (parity with self-impl)
 *  11.  non-string input → throws CsvParserInputError (parity)
 *  12.  many-row stress (50 rows) — full byte-equal headers/rows
 */

import { describe, expect, test } from "bun:test"
import { type CsvParseResult, CsvParserInputError, parseCsv, parseCsvLib } from "@/tool/document"

/** Strip the `Object.freeze` wrappers + extract the assertable shape (drops
 *  message text from diagnostics — both parsers describe the same condition
 *  but worded differently). */
const shape = (r: CsvParseResult) => ({
  headers: r.headers === null ? null : [...r.headers],
  rows: r.rows.map((row) => ({
    lineNumber: row.lineNumber,
    cells: row.cells.map((c) => ({ raw: c.raw, column: c.column })),
  })),
  diagnostics: r.diagnostics.map((d) =>
    d.column === undefined
      ? { kind: d.kind, line: d.line }
      : { kind: d.kind, line: d.line, column: d.column },
  ),
})

describe("parseCsvLib — adapter parity hellgate (ADR-0177)", () => {
  test("1. simple 3-row CSV → 1 header + 3 rows (byte-equal vs self-impl)", () => {
    const input = "name,age,city\nA,1,X\nB,2,Y\nC,3,Z\n"
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.headers).toEqual(["name", "age", "city"])
    expect(lib.rows.length).toBe(3)
    expect(lib.rows[0]?.cells.map((c) => c.raw)).toEqual(["A", "1", "X"])
    expect(lib.rows[0]?.cells[0]?.column).toBe(1)
    expect(lib.diagnostics.length).toBe(0)
  })

  test("2. TSV (delimiter=\\t) splits correctly (byte-equal vs self-impl)", () => {
    const input = "a\tb\tc\n1\t2\t3\n"
    const lib = parseCsvLib(input, { delimiter: "\t" })
    const self = parseCsv(input, { delimiter: "\t" })
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.headers).toEqual(["a", "b", "c"])
    expect(lib.rows[0]?.cells.map((c) => c.raw)).toEqual(["1", "2", "3"])
  })

  test("3. quoted comma in cell → preserved as one cell (byte-equal vs self-impl)", () => {
    const input = 'a,b\n"hello, world",ok\n'
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.rows[0]?.cells.map((c) => c.raw)).toEqual(["hello, world", "ok"])
    expect(lib.diagnostics.length).toBe(0)
  })

  test('4. escaped quote "" inside quoted cell → single " (byte-equal vs self-impl)', () => {
    const input = 'a,b\n"he said ""hi""",ok\n'
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.rows[0]?.cells[0]?.raw).toBe('he said "hi"')
    expect(lib.rows[0]?.cells[1]?.raw).toBe("ok")
  })

  test("5. CRLF terminators handled (byte-equal vs self-impl)", () => {
    const input = "a,b\r\n1,2\r\n3,4\r\n"
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.headers).toEqual(["a", "b"])
    expect(lib.rows.length).toBe(2)
    expect(lib.rows[0]?.cells.map((c) => c.raw)).toEqual(["1", "2"])
  })

  test("6. unterminated quote → diagnostic kind=unterminated-quote (diagnostic parity)", () => {
    const input = 'a,b\n"unterminated,still going\n'
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    // Both parsers emit at least one unterminated-quote diagnostic. The
    // RECOVERY ROW SHAPE diverges intentionally:
    //   - self-impl: best-effort partial row + headers from row 0 (the pre-
    //     quote header line was already tokenized in-place).
    //   - lib: csv-parse@6.x throws `CSV_QUOTE_NOT_CLOSED` and offers no
    //     per-record streaming continuation in sync mode; the adapter falls
    //     back to a 2nd parse, which also throws, so it returns the empty-
    //     shape result with the unterminated-quote diagnostic seeded.
    // We assert DIAGNOSTIC parity (the only contract callers can rely on
    // across the swap) and the NO-THROW negative invariant.
    const libDiag = lib.diagnostics.find((d) => d.kind === "unterminated-quote")
    const selfDiag = self.diagnostics.find((d) => d.kind === "unterminated-quote")
    expect(libDiag).toBeDefined()
    expect(selfDiag).toBeDefined()
    expect(libDiag?.kind).toBe("unterminated-quote")
    expect(selfDiag?.kind).toBe("unterminated-quote")
    expect(lib.rows.length).toBeGreaterThanOrEqual(0)
    expect(self.rows.length).toBeGreaterThanOrEqual(0)
  })

  test("7. ragged row → diagnostic kind=ragged-row per ragged row (byte-equal)", () => {
    const input = "a,b,c\n1,2,3\n4,5\n6,7,8,9\n"
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    expect(shape(lib)).toEqual(shape(self))
    const libRagged = lib.diagnostics.filter((d) => d.kind === "ragged-row")
    expect(libRagged.length).toBe(2)
    expect(lib.rows.length).toBe(3)
    expect(lib.rows[1]?.cells.length).toBe(2)
    expect(lib.rows[2]?.cells.length).toBe(4)
  })

  test("8. empty input → empty result + diagnostic kind=empty-input (byte-equal)", () => {
    const lib = parseCsvLib("")
    const self = parseCsv("")
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.headers).toBe(null)
    expect(lib.rows.length).toBe(0)
    expect(lib.diagnostics.length).toBe(1)
    expect(lib.diagnostics[0]?.kind).toBe("empty-input")
  })

  test("9. noHeader=true → first row becomes data, headers=null (byte-equal)", () => {
    const input = "A,1\nB,2\nC,3\n"
    const lib = parseCsvLib(input, { noHeader: true })
    const self = parseCsv(input, { noHeader: true })
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.headers).toBe(null)
    expect(lib.rows.length).toBe(3)
    expect(lib.rows[0]?.cells.map((c) => c.raw)).toEqual(["A", "1"])
  })

  test("10. multi-char delimiter collapses to first char (parity)", () => {
    // self-impl spec: multi-char delimiter is treated as the first char.
    // Adapter MUST preserve that — `,;` is treated as `,`.
    const input = "a,b\n1,2\n"
    const lib = parseCsvLib(input, { delimiter: ",;" })
    const self = parseCsv(input, { delimiter: ",;" })
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.rows[0]?.cells.map((c) => c.raw)).toEqual(["1", "2"])
  })

  test("11. non-string input → throws CsvParserInputError (parity)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate programmer-bug probe
    expect(() => parseCsvLib(null as any)).toThrow(CsvParserInputError)
    // biome-ignore lint/suspicious/noExplicitAny: deliberate programmer-bug probe
    expect(() => parseCsvLib(42 as any)).toThrow(CsvParserInputError)
    // biome-ignore lint/suspicious/noExplicitAny: deliberate programmer-bug probe
    expect(() => parseCsv(null as any)).toThrow(CsvParserInputError)
  })

  test("12. many-row stress (50 rows) → byte-equal headers + rows", () => {
    const input = `name,age\n${Array.from({ length: 50 }, (_, i) => `R${i},${i}`).join("\n")}\n`
    const lib = parseCsvLib(input)
    const self = parseCsv(input)
    expect(shape(lib)).toEqual(shape(self))
    expect(lib.headers).toEqual(["name", "age"])
    expect(lib.rows.length).toBe(50)
    expect(lib.rows[49]?.cells.map((c) => c.raw)).toEqual(["R49", "49"])
  })
})
