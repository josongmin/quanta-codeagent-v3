/**
 * `docx_read` tool (jun-04) — REAL reader for `.docx` (WordprocessingML).
 *
 * Sibling to the real {@link parseXlsx}: pure-TS, NO dependency. Unzips (STORED +
 * DEFLATE via the authoring slice's {@link unzip}) and extracts paragraph text
 * from `word/document.xml`. Closes the H14b round-trip for the DOCX format
 * (`docx_write` → disk → `docx_read` returns the text).
 *
 *   - {@link parseDocx}: PURE `bytes → {paragraphs, text}` — the testable core.
 *   - {@link docxReadTool}: the FS-jailed tool wrapper (shares
 *     {@link readJailedFileBytes} with `xlsx_read`).
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { unzip } from "./authoring/zip-store"
import { readJailedFileBytes } from "./xlsx-read"

const MAX_DOCX_BYTES = 32 * 1024 * 1024

export const docxReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the DOCX file"),
})
export type DocxReadInput = z.infer<typeof docxReadInputSchema>

export type ParseDocxResult =
  | { readonly ok: true; readonly paragraphs: string[]; readonly text: string }
  | { readonly ok: false; readonly error: string }

const unescapeXml = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Concatenate every `<w:t>…</w:t>` (the WordprocessingML text run) in a `<w:p>`. */
const paragraphText = (paragraphXml: string): string => {
  let out = ""
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
  for (let m = re.exec(paragraphXml); m !== null; m = re.exec(paragraphXml)) {
    out += unescapeXml(m[1] ?? "")
  }
  return out
}

/**
 * Parse `.docx` bytes into paragraph text. No-throw: malformed input or a
 * missing `word/document.xml` → `{ok:false}`. Empty/whitespace paragraphs are
 * preserved positionally (so a heading + body keep their indices).
 */
export const parseDocx = (bytes: Uint8Array): ParseDocxResult => {
  const zip = unzip(bytes)
  if (!zip.ok) return { ok: false, error: `not a valid docx (zip): ${zip.error}` }
  const doc = zip.entries.find((e) => e.path === "word/document.xml")
  if (doc === undefined) return { ok: false, error: "docx: missing word/document.xml" }
  const xml = decode(doc.data)
  const paragraphs: string[] = []
  // `(?<!\/)>` on the paired-tag alternative is LOAD-BEARING: an empty
  // self-closing paragraph `<w:p/>` (Word emits these for blank lines) would
  // otherwise be SWALLOWED by the greedy `[^>]*` of the first alternative,
  // which anchors on the NEXT paragraph's `>` — dropping the blank paragraph
  // and SHIFTING every later paragraph's index (the docstring promises blank
  // paragraphs are preserved positionally). The lookbehind forbids the
  // paired-tag alternative from matching a `/>`, so the self-closing
  // alternative claims `<w:p/>` as its own (empty) paragraph.
  const re = /<w:p\b[^>]*(?<!\/)>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    paragraphs.push(paragraphText(m[1] ?? ""))
  }
  return { ok: true, paragraphs, text: paragraphs.join("\n") }
}

export const docxReadTool: Tool<DocxReadInput> = {
  name: "docx_read",
  description:
    "Read a DOCX document: returns the paragraph text. Pure-TS WordprocessingML " +
    "reader (STORED + DEFLATE). Read-only.",
  inputSchema: docxReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: DocxReadInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = docxReadInputSchema.safeParse(input)
    if (!parsed.success) {
      const result: ToolResult = { ok: false, output: `invalid input: ${parsed.error.message}` }
      yield { type: "result", result }
      return
    }
    const bytesResult = await readJailedFileBytes(ctx, parsed.data.path, MAX_DOCX_BYTES)
    if (!bytesResult.ok) {
      yield { type: "result", result: bytesResult.result }
      return
    }
    const out = parseDocx(bytesResult.bytes)
    if (!out.ok) {
      const result: ToolResult = {
        ok: false,
        output: out.error,
        failure: { mode: "error", modelVisibleError: "docx_malformed" },
      }
      yield { type: "result", result }
      return
    }
    yield { type: "result", result: { ok: true, output: out.text } }
  },
}
