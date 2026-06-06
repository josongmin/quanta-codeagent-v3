/**
 * `pptx_read` tool (H14 PPTX follow-up) — REAL reader for `.pptx` (PresentationML).
 *
 * Sibling to {@link parseXlsx} / {@link parseDocx}: pure-TS, NO dependency.
 * Unzips (STORED + DEFLATE via the authoring slice's {@link unzip}) and extracts
 * each slide's title + body text from `ppt/slides/slideN.xml`. Closes the H14
 * round-trip for the PPTX format (`pptx_write` → disk → `pptx_read` returns the
 * slide text).
 *
 *   - {@link parsePptx}: PURE `bytes → {slides, text}` — the testable core.
 *   - {@link pptxReadTool}: the FS-jailed tool wrapper (shares
 *     {@link readJailedFileBytes} with `xlsx_read` / `docx_read`).
 *
 * Slide ORDER follows the numeric part index (`slide1`, `slide2`, … `slide10`)
 * — NOT lexicographic — so a 12-slide deck reads back in deck order.
 *
 * Title-vs-body split: a slide's FIRST `<p:sp>` shape is, by quanta's
 * serializer, the title placeholder (and PowerPoint marks it `<p:ph type="title"/>`
 * or `type="ctrTitle"`). We treat a title-typed placeholder's text as the title
 * and every OTHER shape's paragraphs as body lines. For a foreign deck with no
 * title placeholder, the title is `undefined` and all text falls into `body`.
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"
import { unescapeXml } from "./authoring/ooxml-read"
import { unzip } from "./authoring/zip-store"
import { readJailedFileBytes } from "./xlsx-read"

const MAX_PPTX_BYTES = 32 * 1024 * 1024

export const pptxReadInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative or absolute path to the PPTX file"),
})
export type PptxReadInput = z.infer<typeof pptxReadInputSchema>

/** One parsed slide: an optional title + ordered body lines. */
export interface PptxSlideText {
  readonly title?: string
  readonly body: string[]
}

export type ParsePptxResult =
  | { readonly ok: true; readonly slides: PptxSlideText[]; readonly text: string }
  | { readonly ok: false; readonly error: string }

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** Concatenate every `<a:t>…</a:t>` (DrawingML text run) within a fragment.
 *  The opening tag may carry attributes (e.g. `xml:space="preserve"` on a
 *  foreign deck), so match `<a:t ...>` attribute-tolerantly — a strict `<a:t>`
 *  silently dropped every attributed run. */
const runText = (fragment: string): string => {
  let out = ""
  const re = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
  for (let m = re.exec(fragment); m !== null; m = re.exec(fragment)) {
    out += unescapeXml(m[1] ?? "")
  }
  return out
}

/** Each `<a:p>` paragraph's concatenated run text (in order). */
const paragraphLines = (shapeXml: string): string[] => {
  const lines: string[] = []
  const re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>|<a:p\b[^>]*\/>/g
  for (let m = re.exec(shapeXml); m !== null; m = re.exec(shapeXml)) {
    lines.push(runText(m[1] ?? ""))
  }
  return lines
}

/** Is this `<p:sp>` shape a TITLE placeholder? (`<p:ph type="title|ctrTitle"/>`) */
const isTitleShape = (shapeXml: string): boolean =>
  /<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/.test(shapeXml)

/** Parse one slide XML into a {title?, body[]}. The FIRST title-typed
 *  placeholder supplies the title; every other shape's non-empty paragraph
 *  lines become body bullets. */
const parseSlide = (xml: string): PptxSlideText => {
  let title: string | undefined
  const body: string[] = []
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  for (let m = shapeRe.exec(xml); m !== null; m = shapeRe.exec(xml)) {
    const shape = m[1] ?? ""
    const lines = paragraphLines(shape).filter((l) => l.length > 0)
    if (title === undefined && isTitleShape(shape)) {
      // The title placeholder's text (its runs joined — usually one line). An
      // empty title placeholder leaves `title` unset (undefined).
      const joined = lines.join(" ")
      if (joined.length > 0) title = joined
    } else {
      body.push(...lines)
    }
  }
  return title === undefined ? { body } : { title, body }
}

/**
 * Parse `.pptx` bytes into per-slide title + body text. No-throw: malformed
 * input or a package with no `ppt/slides/slideN.xml` → `{ok:false}`. Slides are
 * returned in NUMERIC part order (slide1, slide2, …, slide10), not lexicographic.
 */
export const parsePptx = (bytes: Uint8Array): ParsePptxResult => {
  const zip = unzip(bytes)
  if (!zip.ok) return { ok: false, error: `not a valid pptx (zip): ${zip.error}` }
  // Deterministic (locale-independent) slide ordering by the numeric N in
  // `ppt/slides/slideN.xml` — `localeCompare` is forbidden (no-sketchy-code:
  // locale/ICU-dependent → breaks byte-identical replay).
  const slideIndex = (p: string): number => {
    const n = /slide(\d+)\.xml$/.exec(p)?.[1]
    return n !== undefined ? Number.parseInt(n, 10) : Number.MAX_SAFE_INTEGER
  }
  const slideParts = zip.entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.path))
    .sort((a, b) => slideIndex(a.path) - slideIndex(b.path))
  if (slideParts.length === 0) return { ok: false, error: "pptx: no slides found" }
  const slides = slideParts.map((e) => parseSlide(decode(e.data)))
  const text = slides
    .map((s) => [s.title ?? "", ...s.body].filter((l) => l.length > 0).join("\n"))
    .filter((block) => block.length > 0)
    .join("\n\n")
  return { ok: true, slides, text }
}

// ── tool wrapper ─────────────────────────────────────────────────────────────

const errResult = (output: string, failure?: ToolResult["failure"]): ToolResult =>
  failure === undefined ? { ok: false, output } : { ok: false, output, failure }

const renderDeck = (slides: PptxSlideText[]): string => {
  const blocks: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]
    if (s === undefined) continue
    const lines: string[] = [`Slide ${i + 1}${s.title !== undefined ? `: ${s.title}` : ""}`]
    for (const b of s.body) lines.push(`  • ${b}`)
    blocks.push(lines.join("\n"))
  }
  return blocks.join("\n\n")
}

export const pptxReadTool: Tool<PptxReadInput> = {
  name: "pptx_read",
  description:
    "Read a PPTX presentation: returns per-slide title + body bullet text. Pure-TS " +
    "PresentationML reader (STORED + DEFLATE). Read-only.",
  inputSchema: pptxReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: PptxReadInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = pptxReadInputSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    const bytesResult = await readJailedFileBytes(ctx, parsed.data.path, MAX_PPTX_BYTES)
    if (!bytesResult.ok) {
      yield { type: "result", result: bytesResult.result }
      return
    }
    const out = parsePptx(bytesResult.bytes)
    if (!out.ok) {
      yield {
        type: "result",
        result: errResult(out.error, { mode: "error", modelVisibleError: "pptx_malformed" }),
      }
      return
    }
    yield { type: "result", result: { ok: true, output: renderDeck(out.slides) } }
  },
}
