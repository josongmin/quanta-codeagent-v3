// Hellgate — H14 PPTX follow-up: PowerPoint .pptx AUTHORING (pptx_write) + the
// pure PresentationML serializer (`buildPptx`) and reader (`parsePptx`).
//
// Proves the pure-TS STORED-ZIP + PresentationML stack produces a VALID `.pptx`:
//   - the produced bytes are a well-formed ZIP (re-parse central + local headers,
//     re-derive every CRC-32, confirm STORED method),
//   - every spec-minimal PresentationML part is present + well-formed XML
//     ([Content_Types].xml, _rels/.rels, presentation.xml (+rels), slideMaster1
//     (+rels), slideLayout1 (+rels), slideN.xml (+rels), theme1.xml),
//   - slide title + body text ROUND-TRIP through `parsePptx`, including the
//     XML-special chars `< > & "`,
//   - multi-slide decks keep slide order (numeric, not lexicographic),
//   - an empty spec still yields ≥1 valid slide,
//   - jailed-path enforcement (a path outside cwd → permission_denied),
//   - versioned sibling on an existing file (never silent overwrite),
//   - edge specs never throw.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPptx } from "@/tool/document/authoring/pptx"
import { pptxWriteTool } from "@/tool/document/authoring/pptx-write"
import { parseStoredZip, unzip } from "@/tool/document/authoring/zip-store"
import { parsePptx } from "@/tool/document/pptx-read"
import type { ToolContext, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const runTool = async (
  tool: {
    execute: (
      input: never,
      ctx: ToolContext,
    ) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result" && ev.result) last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no result")
  return last
}

const partText = (zip: Uint8Array, path: string): string => {
  const entry = parseStoredZip(zip).find((e) => e.path === path)
  if (entry === undefined) throw new Error(`part not found: ${path}`)
  return new TextDecoder().decode(entry.data)
}

// A pragmatic well-formedness probe: balanced angle brackets + no bare `&`
// (every entity we emit starts `&amp;`/`&lt;`/`&gt;`/`&quot;`/`&#…;`). Catches
// an un-escaped user `<`/`&` leaking into the XML.
const isWellFormedXml = (xml: string): boolean => {
  if (!xml.startsWith("<?xml")) return false
  // No raw `&` that is not the start of a known/numeric entity.
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(xml)) return false
  // Tags balance: count `<` (excluding `<?` and `</`) vs `>`.
  const opens = (xml.match(/</g) ?? []).length
  const closes = (xml.match(/>/g) ?? []).length
  return opens === closes
}

const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
  "ppt/slideMasters/slideMaster1.xml",
  "ppt/slideMasters/_rels/slideMaster1.xml.rels",
  "ppt/slideLayouts/slideLayout1.xml",
  "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
  "ppt/theme/theme1.xml",
  "ppt/slides/slide1.xml",
  "ppt/slides/_rels/slide1.xml.rels",
]

describe("buildPptx — valid PresentationML package", () => {
  test("produces a well-formed STORED ZIP (every CRC verifies, STORED method)", () => {
    const bytes = buildPptx({ slides: [{ title: "Hello", body: ["one", "two"] }] })
    const entries = parseStoredZip(bytes)
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.method).toBe(0) // STORED
      expect(e.computedCrc).toBe(e.storedCrc)
    }
  })

  test("contains every spec-minimal PresentationML part, each well-formed XML", () => {
    const bytes = buildPptx({ slides: [{ title: "T", body: ["b"] }] })
    const paths = new Set(parseStoredZip(bytes).map((e) => e.path))
    for (const p of REQUIRED_PARTS) {
      expect(paths.has(p)).toBe(true)
      expect(isWellFormedXml(partText(bytes, p))).toBe(true)
    }
  })

  test("presentation.xml references one sldId per slide", () => {
    const bytes = buildPptx({ slides: [{ title: "a" }, { title: "b" }, { title: "c" }] })
    const pres = partText(bytes, "ppt/presentation.xml")
    expect((pres.match(/<p:sldId\b/g) ?? []).length).toBe(3)
    // Each slide part + its rels exist.
    const paths = new Set(parseStoredZip(bytes).map((e) => e.path))
    for (let i = 1; i <= 3; i++) {
      expect(paths.has(`ppt/slides/slide${i}.xml`)).toBe(true)
      expect(paths.has(`ppt/slides/_rels/slide${i}.xml.rels`)).toBe(true)
    }
  })

  test("empty spec ⇒ ≥1 valid slide", () => {
    const bytes = buildPptx({ slides: [] })
    const paths = new Set(parseStoredZip(bytes).map((e) => e.path))
    expect(paths.has("ppt/slides/slide1.xml")).toBe(true)
    const parsed = parsePptx(bytes)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.slides.length).toBeGreaterThanOrEqual(1)
  })

  test("deterministic — same spec yields byte-identical output (no clock)", () => {
    const spec = { slides: [{ title: "X", body: ["y"] }] }
    expect(buildPptx(spec)).toEqual(buildPptx(spec))
  })

  test("edge specs never throw", () => {
    expect(() => buildPptx({ slides: [{}] })).not.toThrow()
    expect(() => buildPptx({ slides: [{ title: "" }] })).not.toThrow()
    expect(() => buildPptx({ slides: [{ body: [] }] })).not.toThrow()
    expect(() => buildPptx({ slides: [{ title: "t", body: ["", "", ""] }] })).not.toThrow()
  })
})

describe("parsePptx — round-trips buildPptx output", () => {
  test("slide title + body come back, XML-special chars intact", () => {
    const bytes = buildPptx({
      slides: [{ title: 'Q3 <Plan> & "Goals"', body: ["bullet <1>", "a & b", 'quote "x"'] }],
    })
    const parsed = parsePptx(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.slides.length).toBe(1)
    const s = parsed.slides[0]
    expect(s?.title).toBe('Q3 <Plan> & "Goals"')
    expect(s?.body).toEqual(["bullet <1>", "a & b", 'quote "x"'])
    expect(parsed.text).toContain('Q3 <Plan> & "Goals"')
    expect(parsed.text).toContain("bullet <1>")
  })

  test("multi-slide order preserved (numeric, not lexicographic — slide10 after slide9)", () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({ title: `Slide ${i + 1}` }))
    const bytes = buildPptx({ slides })
    const parsed = parsePptx(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.slides.map((s) => s.title)).toEqual(slides.map((s) => s.title))
  })

  test("unzip reads the package back without error (DEFLATE-capable reader)", () => {
    const bytes = buildPptx({ slides: [{ title: "ok" }] })
    const z = unzip(bytes)
    expect(z.ok).toBe(true)
  })

  test("parsePptx no-throw on garbage bytes", () => {
    const parsed = parsePptx(new Uint8Array([1, 2, 3, 4]))
    expect(parsed.ok).toBe(false)
  })
})

describe("pptx_write tool — jail + versioned sibling + no-throw", () => {
  test("writes a .pptx to a jailed path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pptx-write-"))
    const res = await runTool(
      pptxWriteTool,
      { path: "deck.pptx", slides: [{ title: "Hi", body: ["x"] }] },
      ctx(dir),
    )
    expect(res.ok).toBe(true)
    const bytes = new Uint8Array(await Bun.file(join(dir, "deck.pptx")).arrayBuffer())
    expect(parsePptx(bytes).ok).toBe(true)
  })

  test("path outside cwd ⇒ permission_denied (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pptx-jail-"))
    const res = await runTool(
      pptxWriteTool,
      { path: "../escape.pptx", slides: [{ title: "x" }] },
      ctx(dir),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure?.mode).toBe("permission_denied")
  })

  test("existing target ⇒ versioned -vN sibling (never silent overwrite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pptx-ver-"))
    writeFileSync(join(dir, "deck.pptx"), "OLD")
    const res = await runTool(
      pptxWriteTool,
      { path: "deck.pptx", slides: [{ title: "new" }] },
      ctx(dir),
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.output).toContain("deck-v2.pptx")
    // Original untouched.
    expect(await Bun.file(join(dir, "deck.pptx")).text()).toBe("OLD")
    const bytes = new Uint8Array(await Bun.file(join(dir, "deck-v2.pptx")).arrayBuffer())
    expect(parsePptx(bytes).ok).toBe(true)
  })

  test("invalid input ⇒ typed ok:false (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pptx-bad-"))
    const res = await runTool(pptxWriteTool, { path: "", slides: [] }, ctx(dir))
    expect(res.ok).toBe(false)
  })
})
