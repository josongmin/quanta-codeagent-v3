/**
 * A2 (rich inline) — pure parser unit tests for CSV + notebook artifact bytes.
 *
 * These parsers are the DECISION-free, network-free core of the rich inline
 * renderers: given the raw text of an artifact they produce a normalized shape
 * (grid / cell list) or `null` (malformed ⇒ the caller degrades to a download
 * card, never crashes). Node vitest has no DOM/fetch, so the parse + bound
 * logic is exercised here in isolation from the React render.
 */

import { describe, expect, it } from "vitest"
import { boundCsvRows, parseCsv, parseNotebook } from "./artifact-parse"

describe("parseCsv", () => {
  it("splits a simple table into header + rows", () => {
    const t = parseCsv("a,b,c\n1,2,3\n4,5,6")
    expect(t).not.toBeNull()
    expect(t?.header).toEqual(["a", "b", "c"])
    expect(t?.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ])
  })

  it("honors RFC-4180 quoting: embedded commas, newlines and escaped quotes", () => {
    // field with comma, field with a newline, field with a doubled quote.
    const t = parseCsv('name,note\n"Doe, John","line1\nline2"\n"a ""quote""",z')
    expect(t?.header).toEqual(["name", "note"])
    expect(t?.rows[0]).toEqual(["Doe, John", "line1\nline2"])
    expect(t?.rows[1]).toEqual(['a "quote"', "z"])
  })

  it("tolerates CRLF line endings and a trailing newline", () => {
    const t = parseCsv("h1,h2\r\nx,y\r\n")
    expect(t?.header).toEqual(["h1", "h2"])
    expect(t?.rows).toEqual([["x", "y"]])
  })

  it("supports a semicolon delimiter (Excel-locale export)", () => {
    const t = parseCsv("a;b;c\n1;2;3", ";")
    expect(t?.header).toEqual(["a", "b", "c"])
    expect(t?.rows[0]).toEqual(["1", "2", "3"])
  })

  it("returns null for empty / whitespace-only input (nothing to grid)", () => {
    expect(parseCsv("")).toBeNull()
    expect(parseCsv("   \n  ")).toBeNull()
  })

  it("does NOT hang or crash on an unterminated quote (degrade-safe)", () => {
    // a quote that never closes must terminate at EOF, not loop forever.
    const t = parseCsv('a,b\n"unterminated,c')
    expect(t).not.toBeNull()
    expect(t?.header).toEqual(["a", "b"])
    // the unterminated field absorbs the rest of the line to EOF.
    expect(t?.rows[0]?.[0]).toContain("unterminated")
  })

  it("preserves cell text verbatim (no HTML interpretation in the model)", () => {
    const t = parseCsv("col\n<img src=x onerror=alert(1)>")
    // the parser is a data model — it stores the literal string; escaping is the
    // renderer's job (React escapes text nodes by default).
    expect(t?.rows[0]?.[0]).toBe("<img src=x onerror=alert(1)>")
  })

  // ADV: a 100k-char unterminated quote must terminate at EOF in linear time,
  // not loop (DoS guard) — a hostile artifact cannot hang the render thread.
  it("terminates in linear time on a 100k-char unterminated quote (no hang)", () => {
    const t0 = Date.now()
    const evil = `a,b\n"${"x".repeat(100_000)}`
    expect(parseCsv(evil)).not.toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it("returns a header + empty rows for a single header line (no body)", () => {
    const t = parseCsv("a,b,c")
    expect(t?.header).toEqual(["a", "b", "c"])
    expect(t?.rows).toEqual([])
  })

  it("preserves ragged rows (col count != header) without throwing", () => {
    const t = parseCsv("a,b,c\n1\n2,3,4,5")
    expect(t?.rows[0]).toEqual(["1"])
    expect(t?.rows[1]).toEqual(["2", "3", "4", "5"])
  })
})

describe("boundCsvRows", () => {
  it("caps rows at the limit and reports the overflow count", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [String(i)])
    const b = boundCsvRows(rows, 50)
    expect(b.shown.length).toBe(50)
    expect(b.hidden).toBe(450)
  })

  it("shows all rows and reports 0 hidden when under the limit", () => {
    const rows = [["1"], ["2"]]
    const b = boundCsvRows(rows, 50)
    expect(b.shown.length).toBe(2)
    expect(b.hidden).toBe(0)
  })
})

describe("parseNotebook", () => {
  const nb = JSON.stringify({
    nbformat: 4,
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "body"] },
      {
        cell_type: "code",
        execution_count: 2,
        source: "print('hi')",
        outputs: [
          { output_type: "stream", name: "stdout", text: ["hi\n"] },
          { output_type: "execute_result", data: { "text/plain": "42" } },
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "boom",
            traceback: ["Traceback...", "ValueError: boom"],
          },
        ],
      },
    ],
  })

  it("normalizes markdown + code cells with joined source", () => {
    const cells = parseNotebook(nb)
    expect(cells).not.toBeNull()
    expect(cells?.length).toBe(2)
    expect(cells?.[0]).toMatchObject({ type: "markdown", source: "# Title\nbody" })
    expect(cells?.[1]).toMatchObject({ type: "code", source: "print('hi')", executionCount: 2 })
  })

  it("extracts stream, execute_result and error outputs as text", () => {
    const cells = parseNotebook(nb)
    const outs = cells?.[1]?.outputs ?? []
    // stream text, execute_result text/plain, and the error traceback all
    // surface as readable text blocks.
    const joined = outs.map((o) => o.text).join("\n")
    expect(joined).toContain("hi")
    expect(joined).toContain("42")
    expect(joined).toContain("ValueError: boom")
  })

  it("flags an image/png output so the renderer can show it (not raw base64)", () => {
    const withImg = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "",
          outputs: [{ output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } }],
        },
      ],
    })
    const cells = parseNotebook(withImg)
    const out = cells?.[0]?.outputs?.[0]
    expect(out?.image).toBe("data:image/png;base64,iVBORw0KGgo=")
  })

  it("returns null for non-JSON, and for JSON missing a cells array (degrade-safe)", () => {
    expect(parseNotebook("not json {{{")).toBeNull()
    expect(parseNotebook(JSON.stringify({ nbformat: 4 }))).toBeNull()
    expect(parseNotebook(JSON.stringify({ cells: "nope" }))).toBeNull()
  })

  it("skips malformed cells without crashing the whole notebook", () => {
    const mixed = JSON.stringify({
      cells: [null, 42, { cell_type: "markdown", source: "ok" }, { source: "no-type" }],
    })
    const cells = parseNotebook(mixed)
    // at least the one valid markdown cell survives; bad entries are dropped.
    expect(cells?.some((c) => c.type === "markdown" && c.source === "ok")).toBe(true)
  })

  it("stores output text verbatim (renderer escapes; model does not run HTML)", () => {
    const xss = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "x",
          outputs: [{ output_type: "stream", name: "stdout", text: "<script>alert(1)</script>" }],
        },
      ],
    })
    const cells = parseNotebook(xss)
    expect(cells?.[0]?.outputs?.[0]?.text).toBe("<script>alert(1)</script>")
  })

  // ADV: JSON that parses but is not an object (array / scalar / null / string)
  // must degrade to null, not throw when we read `.cells`.
  it("returns null for JSON that is an array / scalar / string (not a notebook)", () => {
    expect(parseNotebook(JSON.stringify([1, 2, 3]))).toBeNull()
    expect(parseNotebook(JSON.stringify(42))).toBeNull()
    expect(parseNotebook(JSON.stringify(null))).toBeNull()
    expect(parseNotebook('"a bare string"')).toBeNull()
  })

  // ADV: non-string output payloads (number, object, missing) must not crash.
  it("tolerates non-string / missing output payloads without crashing", () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "x",
          outputs: [
            { output_type: "stream", name: "stdout", text: 42 },
            { output_type: "execute_result", data: { "text/plain": ["a", "b"] } },
            { output_type: "error" },
            { output_type: "totally_unknown", foo: 1 },
          ],
        },
      ],
    })
    const cells = parseNotebook(nb)
    // known outputs normalize; the unknown one is dropped; nothing throws.
    expect(cells?.[0]?.outputs?.length).toBeGreaterThanOrEqual(2)
  })

  // ADV (injection lock): the image data-URI mime is drawn ONLY from a fixed
  // image allowlist — an attacker cannot smuggle `text/html` / `javascript:`
  // into the scheme. Only the (opaque) base64 body is attacker-controlled, and
  // a locked image mime means a browser decodes it strictly as image bytes.
  it("locks the image output data-URI to an image/* mime (no scheme injection)", () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "",
          outputs: [
            {
              output_type: "display_data",
              // a hostile notebook also carries an html payload — it must be
              // ignored in favor of (or alongside) only the allowlisted image.
              data: {
                "text/html": "<img src=x onerror=alert(1)>",
                "image/png": "iVBORw0KGgo=",
              },
            },
          ],
        },
      ],
    })
    const out = parseNotebook(nb)?.[0]?.outputs?.[0]
    expect(out?.image).toBe("data:image/png;base64,iVBORw0KGgo=")
    // the html payload never becomes a renderable field.
    expect(JSON.stringify(out)).not.toContain("onerror")
  })
})
