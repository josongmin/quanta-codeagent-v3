// Adversarial Hellgate (ROUND 5 / completeness-critic) — OOXML WRITE-PATH
// corruption via UNPAIRED UTF-16 SURROGATES.
//
// Coverage gap rounds 1-4 missed: the office serializers route ALL user text
// through `xmlText` → `stripIllegalXmlChars`, which (pre-fix) dropped control
// bytes / non-characters but NOT lone surrogates. A JS string can carry a lone
// surrogate when a caller slices through an astral char (a botched emoji
// substring — very reachable from an LLM that string-slices). A lone surrogate
// is NOT a valid Unicode scalar value: UTF-8 encoding it yields an INVALID byte
// sequence, so the emitted `.docx`/`.xlsx`/`.pptx` XML part is malformed and a
// CONFORMING reader (PowerPoint/Word/LibreOffice) refuses to open the file.
//
// These tests pin two invariants at the single sanitization chokepoint:
//   1. a lone high/low surrogate is DROPPED (the XML part is valid UTF-8);
//   2. a VALID surrogate pair (a real astral char / emoji) is PRESERVED.
//
// The per-XML-PART UTF-8 validity (decode with { fatal: true }) is the true
// proof — the whole `.pptx` is a binary ZIP so only the inner parts are XML.

import { describe, expect, test } from "bun:test"
import {
  buildDocx,
  buildPptx,
  buildXlsx,
  parseStoredZip,
  stripIllegalXmlChars,
  xmlText,
} from "@/tool/document/authoring"

const LONE_HI = String.fromCharCode(0xd800) // unpaired high surrogate
const LONE_LO = String.fromCharCode(0xdc00) // unpaired low surrogate
const EMOJI = "\u{1F680}" // U+1F680 rocket — a VALID surrogate pair

/** Decode bytes as UTF-8 with fatal=true; return null on success, the error
 *  string on an invalid byte sequence (the malformed-XML signal). */
const utf8Fatal = (bytes: Uint8Array): string | null => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return null
  } catch (e) {
    return String(e)
  }
}

/** Assert every XML part inside an OOXML zip is valid UTF-8 (would not make a
 *  conforming reader choke). */
const everyPartIsValidUtf8 = (bytes: Uint8Array): void => {
  const entries = parseStoredZip(bytes)
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    // Each STORED-zip entry is the raw part bytes (XML), so each must decode.
    expect(utf8Fatal(entry.data)).toBeNull()
  }
}

describe("stripIllegalXmlChars — unpaired surrogates", () => {
  test("a lone HIGH surrogate is dropped", () => {
    expect(stripIllegalXmlChars(`a${LONE_HI}b`)).toBe("ab")
  })

  test("a lone LOW surrogate is dropped", () => {
    expect(stripIllegalXmlChars(`a${LONE_LO}b`)).toBe("ab")
  })

  test("a VALID surrogate pair (astral char / emoji) is PRESERVED", () => {
    expect(stripIllegalXmlChars(`x${EMOJI}y`)).toBe(`x${EMOJI}y`)
  })

  test("a high surrogate immediately followed by a non-low unit drops only the lone high", () => {
    // high + plain 'A' (not a low surrogate) ⇒ high dropped, 'A' kept.
    expect(stripIllegalXmlChars(`${LONE_HI}A`)).toBe("A")
  })

  test("xmlText output carries no surrogate code unit for lone surrogates", () => {
    const out = xmlText(`p${LONE_HI}q${LONE_LO}r`)
    const codes = [...out].map((c) => c.charCodeAt(0))
    expect(codes.some((c) => c >= 0xd800 && c <= 0xdfff)).toBe(false)
  })
})

describe("OOXML WRITE-PATH — lone surrogate never corrupts the file", () => {
  const hostile = `before${LONE_HI}after${LONE_LO}end ${EMOJI} ok`

  test("pptx: hostile title + body ⇒ every XML part is valid UTF-8", () => {
    everyPartIsValidUtf8(buildPptx({ slides: [{ title: hostile, body: [hostile] }] }))
  })

  test("docx: hostile paragraph ⇒ every XML part is valid UTF-8", () => {
    everyPartIsValidUtf8(
      buildDocx({ paragraphs: [{ kind: "paragraph", runs: [{ text: hostile }] }] }),
    )
  })

  test("xlsx: hostile cell ⇒ every XML part is valid UTF-8", () => {
    everyPartIsValidUtf8(buildXlsx({ sheets: [{ name: "S", rows: [[hostile]] }] }))
  })

  test("emoji survives the round-trip into the slide XML (pair not lost with the lone drops)", () => {
    const bytes = buildPptx({ slides: [{ title: `deck ${EMOJI}`, body: [hostile] }] })
    const entries = parseStoredZip(bytes)
    const slide = entries.find((e) => e.path.endsWith("slides/slide1.xml"))
    expect(slide).toBeDefined()
    if (slide === undefined) return
    expect(new TextDecoder().decode(slide.data)).toContain(EMOJI)
  })
})
