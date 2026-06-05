import { describe, expect, test } from "bun:test"
import { isNotebook, type NotebookRenderOpts, renderNotebook } from "@/tool/read/ipynb"

// jun-6 (ADR-0481) — PURE `renderNotebook` hellgate. Adversarial / edge cases
// over crafted nbformat JSON: base64 image blobs MUST be stripped (token-
// explosion guard), source arrays joined + line-numbered, cell identity/order
// preserved, malformed notebooks fall back to `null` (NEVER throw), outputs cap
// holds, and the outputs knob toggles textual-output appending only.

const OPTS: NotebookRenderOpts = { includeOutputs: true, maxOutputChars: 2000 }
const NO_OUT: NotebookRenderOpts = { includeOutputs: false, maxOutputChars: 2000 }

describe("isNotebook extension gate", () => {
  test("matches .ipynb case-insensitively, nothing else", () => {
    expect(isNotebook("/a/b/notebook.ipynb")).toBe(true)
    expect(isNotebook("/a/b/NoteBook.IPYNB")).toBe(true)
    expect(isNotebook("rel/x.ipynb")).toBe(true)
    expect(isNotebook("/a/b/script.py")).toBe(false)
    expect(isNotebook("/a/b/data.json")).toBe(false)
    // NOT a suffix-anywhere match: only the trailing extension counts.
    expect(isNotebook("/a/ipynb.py")).toBe(false)
    expect(isNotebook("/a/notebook.ipynb.bak")).toBe(false)
  })
})

describe("renderNotebook — base64 image strip (token-explosion guard)", () => {
  test("a 100KB image/png display_data → placeholder, base64 NEVER emitted", () => {
    const blob = "A".repeat(100_000) // 100 KB of fake base64
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: ["plot()\n"],
          outputs: [{ output_type: "display_data", data: { "image/png": blob } }],
        },
      ],
    })
    const out = renderNotebook(nb, OPTS)
    expect(out).not.toBeNull()
    const s = out as string
    // The load-bearing assertion: the base64 payload is absent entirely.
    expect(s.includes(blob)).toBe(false)
    expect(s.includes("AAAAAAAAAA")).toBe(false)
    // A placeholder with the estimated decoded byte length is present instead.
    expect(s).toContain("image output: image/png")
    expect(s).toContain("bytes elided")
    // estimate ~= 100000 * 3/4 = 75000 (no padding here)
    expect(s).toContain("75000 bytes elided")
  })

  test("execute_result with both text/plain and image/jpeg → text kept, image stripped", () => {
    const blob = "Z".repeat(40_000)
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "img",
          outputs: [
            {
              output_type: "execute_result",
              data: { "text/plain": "<Figure>", "image/jpeg": blob },
            },
          ],
        },
      ],
    })
    const s = renderNotebook(nb, OPTS) as string
    expect(s.includes(blob)).toBe(false)
    expect(s).toContain("<Figure>")
    expect(s).toContain("image output: image/jpeg")
  })
})

describe("renderNotebook — source array join + line numbering", () => {
  test("source:string[] renders line-numbered lines, NOT a JSON array literal", () => {
    const nb = JSON.stringify({
      cells: [{ cell_type: "code", source: ["import os\n", "x = 1\n"] }],
    })
    const s = renderNotebook(nb, OPTS) as string
    expect(s).toContain("[cell 0 · code]")
    expect(s).toContain("1\timport os")
    expect(s).toContain("2\tx = 1")
    // Not the raw array literal.
    expect(s.includes('["import os')).toBe(false)
    expect(s.includes("\\n")).toBe(false)
  })

  test("source as a plain string is rendered too", () => {
    const nb = JSON.stringify({ cells: [{ cell_type: "markdown", source: "# Title\nbody" }] })
    const s = renderNotebook(nb, OPTS) as string
    expect(s).toContain("[cell 0 · markdown]")
    expect(s).toContain("1\t# Title")
    expect(s).toContain("2\tbody")
  })
})

describe("renderNotebook — cell identity / order preserved", () => {
  test("mixed code+markdown cells keep order and stable indices", () => {
    const nb = JSON.stringify({
      cells: [
        { cell_type: "code", source: "a=1" },
        { cell_type: "markdown", source: "## notes" },
        { cell_type: "code", source: "b=2" },
      ],
    })
    const s = renderNotebook(nb, OPTS) as string
    const i0 = s.indexOf("[cell 0 · code]")
    const i1 = s.indexOf("[cell 1 · markdown]")
    const i2 = s.indexOf("[cell 2 · code]")
    expect(i0).toBeGreaterThanOrEqual(0)
    expect(i1).toBeGreaterThan(i0)
    expect(i2).toBeGreaterThan(i1)
  })
})

describe("renderNotebook — malformed / corrupt ⇒ null (NO THROW)", () => {
  test("truncated JSON → null", () => {
    expect(renderNotebook('{"cells":[{"cell_type":"code","source"', OPTS)).toBeNull()
  })
  test("cells is not an array → null", () => {
    expect(renderNotebook('{"cells":"nope"}', OPTS)).toBeNull()
  })
  test("top-level is an array, no cells key → null", () => {
    expect(renderNotebook("[1,2,3]", OPTS)).toBeNull()
  })
  test("not JSON at all → null", () => {
    expect(renderNotebook("import os\nx = 1\n", OPTS)).toBeNull()
  })
  test("null / number / string JSON → null", () => {
    expect(renderNotebook("null", OPTS)).toBeNull()
    expect(renderNotebook("42", OPTS)).toBeNull()
    expect(renderNotebook('"hello"', OPTS)).toBeNull()
  })
})

describe("renderNotebook — empty notebook", () => {
  test("zero cells → a clean sentinel, not an empty string", () => {
    const s = renderNotebook('{"cells":[],"nbformat":4}', OPTS) as string
    expect(s).toBe("(empty notebook: 0 cells)")
  })
})

describe("renderNotebook — outputs knob + error + cap", () => {
  test("includeOutputs:false → source present, no [output] section", () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "print(1)",
          outputs: [{ output_type: "stream", text: "1\n" }],
        },
      ],
    })
    const s = renderNotebook(nb, NO_OUT) as string
    expect(s).toContain("1\tprint(1)")
    expect(s.includes("[output]")).toBe(false)
  })

  test("error output renders ename: evalue + traceback", () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "1/0",
          outputs: [
            {
              output_type: "error",
              ename: "ZeroDivisionError",
              evalue: "division by zero",
              traceback: ["Traceback...", "ZeroDivisionError: division by zero"],
            },
          ],
        },
      ],
    })
    const s = renderNotebook(nb, OPTS) as string
    expect(s).toContain("ZeroDivisionError: division by zero")
    expect(s).toContain("Traceback...")
  })

  test("a 1MB stream text is truncated to maxOutputChars (no unbounded emit)", () => {
    const huge = "x".repeat(1_000_000)
    const nb = JSON.stringify({
      cells: [
        { cell_type: "code", source: "spam()", outputs: [{ output_type: "stream", text: huge }] },
      ],
    })
    const s = renderNotebook(nb, { includeOutputs: true, maxOutputChars: 2000 }) as string
    // The rendered doc is far smaller than the 1MB blob; cap marker present.
    expect(s.length).toBeLessThan(10_000)
    expect(s).toContain("chars elided")
  })
})

describe("renderNotebook — fail-soft on odd shapes (NO THROW)", () => {
  test("a cell that is not an object renders a placeholder header, no crash", () => {
    const s = renderNotebook('{"cells":[null, 5, "str"]}', OPTS) as string
    expect(s).toContain("[cell 0 · unknown]")
    expect(s).toContain("[cell 1 · unknown]")
    expect(s).toContain("[cell 2 · unknown]")
  })

  test("missing cell_type / source / non-array outputs are tolerated", () => {
    const nb = JSON.stringify({ cells: [{ source: 123, outputs: "not-array" }] })
    const s = renderNotebook(nb, OPTS) as string
    expect(s).toContain("[cell 0 · unknown]")
    expect(s.includes("[output]")).toBe(false)
  })
})
