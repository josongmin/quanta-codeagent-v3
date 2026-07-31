/**
 * Hellgate (jun-06 ADVERSARIAL audit) — `pptx-read.ts` OOXML defects, the SAME
 * bug class the xlsx/docx siblings were hardened against (R3 self-close drift,
 * R5 surrogate/range-safe unescape) but which `pptx-read` had NOT yet absorbed.
 *
 * REAL BUGS (found this round, fixed in `pptx-read.ts`):
 *
 *  1. OOXML-DoS (throw out of no-throw parse): the inline `unescapeXml` called
 *     `String.fromCodePoint(parseInt(...))` UNGUARDED. A hostile numeric char
 *     ref past Unicode's ceiling (`&#x110000;`, `&#9999999999;`) makes
 *     `String.fromCodePoint` throw `RangeError` — which escaped `parsePptx`
 *     (NOT wrapped in try/catch by the tool `execute`) and crashed dispatch.
 *     FIX: route through the range-safe shared `unescapeXml` (`./authoring/
 *     ooxml-read`), which drops an out-of-range code point to "".
 *
 *  2. POSITIONAL-DRIFT (paragraph): `paragraphLines` used the paired-tag
 *     alternative `<a:p\b[^>]*>…</a:p>` with NO `(?<!\/)>` lookbehind, so a
 *     self-closing blank `<a:p/>` was swallowed — dropping the blank line and
 *     absorbing the FOLLOWING paragraph's runs into the wrong slot.
 *
 *  3. POSITIONAL-DRIFT (shape): `parseSlide`'s `<p:sp\b[^>]*>…</p:sp>` had no
 *     self-close handling — a self-closing `<p:sp/>` swallowed the next shape,
 *     so its runs (possibly a title placeholder's) were attributed to the wrong
 *     shape. FIX (2+3): `(?<!\/)>` lookbehind + self-close alternative.
 *
 *  4. TEXT LOSS on foreign decks: `runText` matched bare `<a:t>` only, so a
 *     real-world `<a:t xml:space="preserve"> … </a:t>` (attributes) was DROPPED
 *     entirely. FIX: `<a:t\b[^>]*>` (mirrors the xlsx/docx `<…t[^>]*>` siblings).
 *
 * Each case is RED before its fix and GREEN after. No-throw + determinism are
 * pinned alongside.
 */

import { describe, expect, test } from "bun:test"
import { buildStoredZip, textEntry } from "@/tool/document/authoring/zip-store"
import { parsePptx } from "@/tool/document/pptx-read"

/** Wrap a `<p:spTree>` shape sequence into a minimal slide1.xml package. */
const pptxFrom = (shapesXml: string): Uint8Array =>
  buildStoredZip([
    textEntry(
      "ppt/slides/slide1.xml",
      `<p:sld><p:cSld><p:spTree>${shapesXml}</p:spTree></p:cSld></p:sld>`,
    ),
  ])

const sp = (inner: string): string => `<p:sp>${inner}</p:sp>`
const titlePh = `<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>`
const bodyPh = `<p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>`
const para = (t: string): string => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`

const parseOrThrow = (bytes: Uint8Array) => {
  const r = parsePptx(bytes)
  if (!r.ok) throw new Error(`parse failed: ${r.error}`)
  return r
}

describe("pptx-read OOXML-DoS + positional-drift + text-loss (jun-06)", () => {
  // ── 1. OOXML-DoS: hostile numeric char ref must NOT throw ──────────────────
  test("hex char ref past Unicode ceiling (&#x110000;) → no-throw, dropped", () => {
    const bytes = pptxFrom(sp(bodyPh + para("a&#x110000;b")))
    let r: ReturnType<typeof parsePptx> | undefined
    expect(() => {
      r = parsePptx(bytes)
    }).not.toThrow()
    expect(r?.ok).toBe(true)
    // The out-of-range code point is dropped (range-safe), surrounding text kept.
    if (r?.ok) expect(r.text).toBe("ab")
  })

  test("decimal char ref past 32-bit (&#9999999999;) → no-throw, dropped", () => {
    const bytes = pptxFrom(sp(bodyPh + para("x&#9999999999;y")))
    expect(() => parsePptx(bytes)).not.toThrow()
    const r = parseOrThrow(bytes)
    if (r.ok) expect(r.text).toBe("xy")
  })

  test("VALID astral char ref (&#x1F680;) is preserved (range-safe, not over-eager)", () => {
    const r = parseOrThrow(pptxFrom(sp(bodyPh + para("go&#x1F680;"))))
    if (r.ok) expect(r.text).toBe("go\u{1F680}")
  })

  test("lone surrogate ref (&#xD800;) is DROPPED (R5 class) — output is well-formed", () => {
    const r = parseOrThrow(pptxFrom(sp(bodyPh + para("p&#xD800;q"))))
    if (!r.ok) return
    // U+D800 is a lone surrogate (not a Unicode scalar value); safeCodePoint
    // drops it so the extracted text is well-formed (no lone-surrogate corruption).
    expect(r.text.isWellFormed()).toBe(true)
    expect(r.text).toBe("pq")
  })

  // ── 2. POSITIONAL-DRIFT (paragraph): self-closing <a:p/> ───────────────────
  test("self-closing blank <a:p/> does NOT swallow the next paragraph's runs", () => {
    // first / blank / third — body-shape paragraphs. Before the fix the blank
    // <a:p/> swallowed up to "third"'s </a:p>, dropping a paragraph.
    const r = parseOrThrow(pptxFrom(sp(`${bodyPh + para("first")}<a:p/>${para("third")}`)))
    if (!r.ok) return
    const slide = r.slides[0]
    expect(slide).toBeDefined()
    // The blank paragraph is empty (filtered from body), but BOTH real lines
    // survive in order — no drift / no drop of "third".
    expect(slide?.body).toEqual(["first", "third"])
  })

  test("leading self-closing <a:p/> does NOT absorb the first real paragraph", () => {
    const r = parseOrThrow(pptxFrom(sp(`${bodyPh}<a:p/>${para("real")}`)))
    if (!r.ok) return
    expect(r.slides[0]?.body).toEqual(["real"])
  })

  // ── 3. POSITIONAL-DRIFT (shape): self-closing <p:sp/> ──────────────────────
  test("self-closing <p:sp/> does NOT swallow the following title shape", () => {
    // A self-closing empty shape, THEN the title placeholder. Before the fix the
    // <p:sp/> swallowed the title shape, mis-attributing the run.
    const r = parseOrThrow(
      pptxFrom(`<p:sp/>${sp(titlePh + para("Real Title"))}${sp(bodyPh + para("body"))}`),
    )
    if (!r.ok) return
    expect(r.slides[0]?.title).toBe("Real Title")
    expect(r.slides[0]?.body).toEqual(["body"])
  })

  test("self-closing <p:sp/> between title and body keeps body intact", () => {
    const r = parseOrThrow(pptxFrom(`${sp(titlePh + para("T"))}<p:sp/>${sp(bodyPh + para("B"))}`))
    if (!r.ok) return
    expect(r.slides[0]?.title).toBe("T")
    expect(r.slides[0]?.body).toEqual(["B"])
  })

  // ── 4. TEXT LOSS: <a:t> with attributes (foreign decks) ────────────────────
  test('foreign-deck <a:t xml:space="preserve"> run is NOT dropped', () => {
    const r = parseOrThrow(
      pptxFrom(sp(`${bodyPh}<a:p><a:r><a:t xml:space="preserve">Hello World</a:t></a:r></a:p>`)),
    )
    if (!r.ok) return
    expect(r.slides[0]?.body).toEqual(["Hello World"])
  })

  test("<a:t\\b> does NOT spuriously match siblings like <a:tab/> / <a:tcPr>", () => {
    // A paragraph with a <a:tab/> control element and a real <a:t>.
    const r = parseOrThrow(pptxFrom(sp(`${bodyPh}<a:p><a:r><a:tab/><a:t>kept</a:t></a:r></a:p>`)))
    if (!r.ok) return
    expect(r.slides[0]?.body).toEqual(["kept"])
  })

  // ── determinism + no-throw on adversarial structure ────────────────────────
  test("deeply-nested / truncated slide XML → no-throw typed result", () => {
    const truncated = buildStoredZip([
      textEntry("ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree><p:sp><a:p><a:t>x`),
    ])
    expect(() => parsePptx(truncated)).not.toThrow()
  })

  test("parse is deterministic (same bytes → same text)", () => {
    const bytes = pptxFrom(sp(titlePh + para("T")) + sp(bodyPh + para("B1") + para("B2")))
    const a = parsePptx(bytes)
    const b = parsePptx(bytes)
    expect(a.ok && b.ok && a.text === b.text).toBe(true)
  })
})
