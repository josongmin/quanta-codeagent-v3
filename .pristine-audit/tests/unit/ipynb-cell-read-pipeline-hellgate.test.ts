import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import type { ToolContext, ToolResult } from "@/tool"
import { readTool } from "@/tool/read"

// jun-6 (ADR-0481) — `read` PIPELINE hellgate. Proves the extension gate end to
// end through the real read tool: a `.ipynb` renders cell-by-cell with base64
// stripped; a NON-.ipynb file is BYTE-IDENTICAL to the pre-ADR raw render (even
// a `.json` file whose CONTENT is a notebook — the gate is on EXTENSION, not
// content); a corrupt `.ipynb` falls back to the raw text (NO throw).

const dir = mkdtempSync(join(tmpdir(), "ipynb-read-hellgate-"))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  __resetRuntimeConfig()
})

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (path: string, cwd = dir): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readTool.execute({ path } as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "code", source: ["import os\n", "x = 1\n"] },
    { cell_type: "markdown", source: "## section" },
    {
      cell_type: "code",
      source: "plot()",
      outputs: [{ output_type: "display_data", data: { "image/png": "B".repeat(80_000) } }],
    },
  ],
  nbformat: 4,
})

describe("read pipeline — .ipynb renders cells, strips base64", () => {
  test("a real .ipynb is rendered cell-by-cell with no base64 blob", async () => {
    const f = join(dir, "analysis.ipynb")
    writeFileSync(f, NOTEBOOK)
    const r = await run(f)
    expect(r.ok).toBe(true)
    const out = r.output as string
    expect(out).toContain("[cell 0 · code]")
    expect(out).toContain("import os")
    expect(out).toContain("[cell 1 · markdown]")
    expect(out).toContain("[cell 2 · code]")
    expect(out).toContain("image output: image/png")
    // The base64 blob is gone — the bug this ADR kills.
    expect(out.includes("B".repeat(80_000))).toBe(false)
    expect(out.includes("BBBBBBBBBB")).toBe(false)
  })
})

describe("read pipeline — byte-identity for non-.ipynb (extension gate)", () => {
  test("a .json file whose CONTENT is a notebook is NOT cell-parsed (raw render)", async () => {
    const f = join(dir, "config.json")
    // Same notebook bytes, but a .json extension ⇒ must read raw (line-numbered
    // JSON), NOT the cell render. Gate is on extension, not content.
    writeFileSync(f, '{"cells":[{"cell_type":"code","source":"x=1"}]}')
    const r = await run(f)
    expect(r.ok).toBe(true)
    const out = r.output as string
    // Raw render: a single line-numbered JSON line, no cell header.
    expect(out.includes("[cell 0")).toBe(false)
    expect(out).toBe('1\t{"cells":[{"cell_type":"code","source":"x=1"}]}')
  })

  test("a .py file is rendered exactly as the raw line-numbered text", async () => {
    const f = join(dir, "script.py")
    writeFileSync(f, "import os\nx = 1\n")
    const r = await run(f)
    expect(r.ok).toBe(true)
    // Trailing newline → an empty final line in the raw render (unchanged).
    expect(r.output).toBe("1\timport os\n2\tx = 1\n3\t")
  })
})

describe("read pipeline — corrupt .ipynb falls back to raw (NO throw)", () => {
  test("truncated notebook JSON reads as raw text, no crash", async () => {
    const f = join(dir, "broken.ipynb")
    const truncated = '{"cells":[{"cell_type":"code","source":["x'
    writeFileSync(f, truncated)
    const r = await run(f)
    expect(r.ok).toBe(true)
    const out = r.output as string
    // No cell render (it was unparseable); the raw bytes are line-numbered.
    expect(out.includes("[cell 0")).toBe(false)
    expect(out).toContain('{"cells":[{"cell_type":"code"')
  })

  test("an empty .ipynb (0 cells) renders the clean sentinel", async () => {
    const f = join(dir, "empty.ipynb")
    writeFileSync(f, '{"cells":[],"nbformat":4}')
    const r = await run(f)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("(empty notebook: 0 cells)")
  })
})

describe("read pipeline — QUANTA_IPYNB_OUTPUTS knob (default ON)", () => {
  test("default (unset) appends textual outputs", async () => {
    __resetRuntimeConfig()
    const f = join(dir, "with-output.ipynb")
    writeFileSync(
      f,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "print('hi')",
            outputs: [{ output_type: "stream", text: "hi\n" }],
          },
        ],
      }),
    )
    const r = await run(f)
    expect(r.output as string).toContain("[output]")
    expect(r.output as string).toContain("hi")
  })

  test("QUANTA_IPYNB_OUTPUTS=off renders source only", async () => {
    const prev = process.env.QUANTA_IPYNB_OUTPUTS
    process.env.QUANTA_IPYNB_OUTPUTS = "off"
    __resetRuntimeConfig()
    try {
      const f = join(dir, "no-output.ipynb")
      writeFileSync(
        f,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: "print('hi')",
              outputs: [{ output_type: "stream", text: "hi\n" }],
            },
          ],
        }),
      )
      const r = await run(f)
      const out = r.output as string
      expect(out).toContain("print('hi')")
      expect(out.includes("[output]")).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.QUANTA_IPYNB_OUTPUTS
      else process.env.QUANTA_IPYNB_OUTPUTS = prev
      __resetRuntimeConfig()
    }
  })
})
