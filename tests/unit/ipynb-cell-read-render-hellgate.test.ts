import { describe, expect, test } from "bun:test"
import {
  isNotebook,
  MAX_NOTEBOOK_CELLS,
  MAX_OUTPUTS_PER_CELL,
  type NotebookRenderOpts,
  renderNotebook,
} from "@/tool/read/ipynb"

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

  test("a CHUNKED 10MB image (string[] form) → placeholder, blob NEVER joined or emitted", () => {
    // nbformat permits `data["image/png"]` as a `string[]`. A 10MB image split
    // into 10k chunks must be elided WITHOUT concatenating the chunks into one
    // giant string (the DoS the per-output cap does not bound). We assert the
    // payload is absent AND the byte estimate matches the un-joined total.
    const chunk = "Q".repeat(1_000) // 1000 base64 chars
    const chunks = Array.from({ length: 10_000 }, () => chunk) // 10M chars total
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "show(img)",
          outputs: [{ output_type: "display_data", data: { "image/png": chunks } }],
        },
      ],
    })
    const s = renderNotebook(nb, OPTS) as string
    // Payload absent — not a single 1000-char chunk leaked.
    expect(s.includes(chunk)).toBe(false)
    expect(s).toContain("image output: image/png")
    // 10_000_000 chars, no padding → 10_000_000 * 3/4 = 7_500_000 bytes.
    expect(s).toContain("7500000 bytes elided")
    // The rendered doc is tiny — the multi-MB blob was NEVER materialized.
    expect(s.length).toBeLessThan(2_000)
  })

  test("a chunked base64 with trailing `==` padding estimates the correct decoded size", () => {
    // Padding lives only on the LAST chunk; estimate must subtract it.
    const chunks = ["AAAA", "BB=="] // 8 chars, 2 pad → 8*3/4 - 2 = 4 bytes
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "x",
          outputs: [{ output_type: "display_data", data: { "image/gif": chunks } }],
        },
      ],
    })
    const s = renderNotebook(nb, OPTS) as string
    expect(s).toContain("4 bytes elided")
  })

  test("a non-string/non-array image value → 0 bytes (fail-soft, never throws)", () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "x",
          outputs: [{ output_type: "display_data", data: { "image/png": { weird: true } } }],
        },
      ],
    })
    const s = renderNotebook(nb, OPTS) as string
    expect(s).toContain("image output: image/png, 0 bytes elided")
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

// ── Document-level DoS caps (the per-OUTPUT cap does NOT bound these) ──────────
// A hostile notebook materializes the FULL rendered string in memory BEFORE the
// read pipeline's offset/limit ever pages it. The per-output char cap leaves two
// holes: (a) a notebook with millions of cells, and (b) a single cell carrying
// tens of thousands of (individually-capped) outputs whose SUM is unbounded.
//
// SPLIT — the exhaustive magnitudes live in
// `tests/unit/ipynb-render-document-caps.nightly.test.ts`. MEASURED peak RSS of
// this file before the split: 620/620/622 MiB over a ~53 MiB interpreter
// baseline, of which the single `50k outputs` case accounted for 547 MiB and
// `200k cells` for 134 MiB. After: 115/107/107 MiB. What stays here is
// the CAP BOUNDARY, which is what distinguishes a capping render from a
// non-capping one; what moved is the MAGNITUDE, which distinguishes a render
// that caps BEFORE materialising from one that caps after. Both properties are
// still asserted — see `tests/_helpers/split-universe.ts` for the union.
describe("renderNotebook — document-level DoS caps", () => {
  test("[case:doc-cap-cells-boundary] one cell past MAX_NOTEBOOK_CELLS elides exactly one", () => {
    // MINIMUM: cap + 1. At exactly the cap a capping and a non-capping render
    // are indistinguishable, so 5001 is the smallest input that can fail. The
    // assertions are on the exact header count and the exact elision text — not
    // on a length threshold, which is what forced the previous version of this
    // property to use 200,000 cells before it could fail.
    const cells = Array.from({ length: MAX_NOTEBOOK_CELLS + 1 }, () => ({
      cell_type: "code",
      source: ["x = 1\n"],
    }))
    const s = renderNotebook(JSON.stringify({ cells }), OPTS) as string
    expect((s.match(/\[cell \d+ · code\]/g) ?? []).length).toBe(MAX_NOTEBOOK_CELLS)
    expect(s).toContain(`[cell ${MAX_NOTEBOOK_CELLS - 1} · code]`)
    expect(s.includes(`[cell ${MAX_NOTEBOOK_CELLS} · code]`)).toBe(false)
    expect(s).toContain("1 more cell(s) elided")
  })

  test("[case:doc-cap-outputs-boundary] one output past MAX_OUTPUTS_PER_CELL elides exactly one", () => {
    // MINIMUM: cap + 1 outputs, each AT the 2000-char per-output cap. The width
    // is load-bearing: with narrower outputs a render that applies only the
    // character cap and never the count cap would still pass.
    const outputs = Array.from({ length: MAX_OUTPUTS_PER_CELL + 1 }, () => ({
      output_type: "stream",
      text: "y".repeat(2_000),
    }))
    const nb = JSON.stringify({ cells: [{ cell_type: "code", source: ["spam()\n"], outputs }] })
    const s = renderNotebook(nb, { includeOutputs: true, maxOutputChars: 2000 }) as string
    expect(s).toContain(`1 more output(s) elided: output cap ${MAX_OUTPUTS_PER_CELL}`)
    // …and the cap really bounds the render: 65 uncapped outputs would be 130k.
    expect(s.length).toBeLessThan(MAX_OUTPUTS_PER_CELL * 2_000 + 5_000)
  })

  test("[case:doc-cap-at-cell-cap] a notebook AT the cell cap (5000) renders every cell, no elision marker", () => {
    const cells = Array.from({ length: MAX_NOTEBOOK_CELLS }, () => ({
      cell_type: "code",
      source: ["a\n"],
    }))
    const s = renderNotebook(JSON.stringify({ cells }), OPTS) as string
    expect(s).toContain(`[cell ${MAX_NOTEBOOK_CELLS - 1} · code]`)
    expect(s.includes("more cell(s) elided")).toBe(false)
  })
})
