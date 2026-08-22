/**
 * H14b round-trip — shared OOXML READ-side primitives (the inverse of
 * `ooxml.ts`'s write-side escaping).
 *
 * The xlsx + docx readers both need to (a) un-escape the five predefined XML
 * entities a serializer wrote, and (b) pull text out of simple, well-known
 * element shapes. We do NOT ship a general XML DOM parser — installs are blocked
 * and OOXML's parts we read are spec-fixed shapes (`<si><t>…</t></si>`,
 * `<c …><v>…</v></c>`, `<w:t>…</w:t>`). A targeted, allocation-light scanner over
 * those shapes is correct AND avoids dragging in a parser dependency.
 *
 * Pure functions over `string`; imports nothing.
 */

/**
 * Un-escape the five predefined XML entities + the common numeric character
 * references. The inverse of `escapeXml`; ORDER matters — `&amp;` is resolved
 * LAST so a literal `&lt;` written as `&amp;lt;` round-trips to `&lt;` (not `<`).
 */
export const unescapeXml = (s: string): string => {
  if (s.indexOf("&") === -1) return s // fast path — no entities
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
}

/** Convert a numeric char-ref code point to a string, dropping invalid ones
 *  (an out-of-range, NaN, or lone-surrogate code point yields ""). A surrogate
 *  (0xD800–0xDFFF) is not a scalar value: `String.fromCodePoint` would emit an
 *  ill-formed lone surrogate, so we drop it to keep readers' output
 *  well-formed (`.isWellFormed()`). */
const safeCodePoint = (cp: number): string => {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ""
  if (cp >= 0xd800 && cp <= 0xdfff) return ""
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ""
  }
}

/**
 * Extract the concatenated text content of EVERY occurrence of a given element
 * (matched by local name, namespace-prefix-agnostic) in document order.
 *
 * Handles both `<tag …>text</tag>` and self-closing `<tag/>` (the latter
 * contributes no text). The match is shape-targeted (the element's text is
 * everything up to its matching close tag, with NO nested same-name elements —
 * true for `<t>`, `<v>`, `<si>` leaf text nodes in OOXML). Returns the list of
 * UN-ESCAPED text fragments.
 *
 * `localName` is the bare element name without prefix (e.g. `"t"` matches both
 * `<t>` and `<w:t>`); we match `<(?:\w+:)?t\b`.
 */
export const extractElementTexts = (xml: string, localName: string): string[] => {
  const out: string[] = []
  // Open tag: optional prefix, the name, a word boundary, then attrs up to `>`.
  // We then read until the matching close tag `</…name>`.
  const open = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escapeRe(localName)}(\\s[^>]*)?(/?)>`, "g")
  let m: RegExpExecArray | null = open.exec(xml)
  while (m !== null) {
    if (m[2] === "/") {
      // self-closing — no text content
      out.push("")
    } else {
      const contentStart = m.index + m[0].length
      const close = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${escapeRe(localName)}>`, "g")
      close.lastIndex = contentStart
      const cm = close.exec(xml)
      if (cm === null) break // malformed — stop gracefully
      out.push(unescapeXml(xml.slice(contentStart, cm.index)))
      open.lastIndex = cm.index + cm[0].length
    }
    m = open.exec(xml)
  }
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
