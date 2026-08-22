/**
 * H14b — shared OOXML primitives reused by the xlsx + docx serializers.
 *
 * OOXML (Office Open XML, ISO/IEC 29500) packages are ZIP containers (see
 * {@link buildStoredZip}) whose parts are XML. EVERY format needs:
 *   - a `[Content_Types].xml` part declaring the MIME type of each part
 *     (by extension default + per-part override), and
 *   - a root `_rels/.rels` part wiring the package to its main document part.
 *
 * This module owns the two cross-format pieces (XML escaping + the package
 * relationship/content-type scaffolding) so `xlsx.ts` and `docx.ts` stay focused
 * on their own body XML. Pure functions; imports nothing.
 *
 * SECURITY — XML injection. EVERY user string that lands in an XML text node or
 * attribute MUST go through {@link escapeXml}. The five predefined XML entities
 * (`& < > " '`) are escaped; a raw `<` from user data can never open a tag.
 */

/** XML declaration prefix shared by every part. Standalone="yes" matches what
 *  Office itself emits. No trailing newline (byte-stable). */
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/**
 * Escape the five predefined XML entities so user text is safe in BOTH element
 * content and double-quoted attribute values. Order matters: `&` first so we
 * don't double-escape the entities we then introduce.
 */
export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

/**
 * Strip characters XML 1.0 forbids even when entity-escaped. XML 1.0 §2.2
 * allows tab (0x09), LF (0x0A), CR (0x0D) and then 0x20+ (minus the U+FFFE /
 * U+FFFF non-characters). Office REJECTS a file containing a raw control byte.
 * We drop them — rather than error — so a caller pasting binary-ish text still
 * gets a valid file (those bytes were never representable in XML anyway).
 * Applied by the serializers BEFORE {@link escapeXml}.
 *
 * UNPAIRED SURROGATES: a JS string is UTF-16 and may carry a LONE surrogate
 * (a high D800–DBFF with no following low, or a stray low DC00–DFFF) — e.g. when
 * a caller slices through an astral char (a botched emoji substring). Such a
 * unit is NOT a valid Unicode scalar value: UTF-8 encoding it yields an INVALID
 * byte sequence, so the resulting `.docx`/`.xlsx`/`.pptx` part is malformed and
 * a conforming reader (PowerPoint/Word/LibreOffice) REFUSES to open the file.
 * We drop lone surrogates here while PRESERVING valid pairs (real astral chars
 * like emoji survive intact). This is the single sanitization chokepoint for all
 * three OOXML serializers, so the fix covers every user-text path at once.
 *
 * Implemented char-by-char (not a regex with control-char class literals) so
 * the SOURCE itself contains no raw control bytes.
 */
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** True when a BMP code unit (non-surrogate) is a legal standalone XML 1.0
 *  char: tab/LF/CR, or 0x20+ excluding the U+FFFE/U+FFFF non-characters. */
const isLegalBmpXmlChar = (c: number): boolean => {
  if (c === 0x09 || c === 0x0a || c === 0x0d) return true
  if (c < 0x20) return false
  return c !== 0xfffe && c !== 0xffff
}

export const stripIllegalXmlChars = (s: string): string => {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (isHighSurrogate(c)) {
      // Keep the PAIR only when a low surrogate follows (a valid astral char,
      // e.g. an emoji). A lone high surrogate UTF-8-encodes to an invalid byte
      // sequence ⇒ drop it (emit nothing).
      if (isLowSurrogate(s.charCodeAt(i + 1))) {
        out += s.slice(i, i + 2)
        i++
      }
      continue
    }
    // A lone low surrogate (any valid pair was consumed above) ⇒ drop.
    if (isLowSurrogate(c)) continue
    if (isLegalBmpXmlChar(c)) out += s[i]
  }
  return out
}

/** Sanitize + escape user text for an XML text node or attribute in one step. */
export const xmlText = (s: string): string => escapeXml(stripIllegalXmlChars(s))

/** A relationship in a `.rels` part: id → (type, target). */
export interface OoxmlRelationship {
  readonly id: string
  readonly type: string
  readonly target: string
}

/** Serialize a `_rels/*.rels` relationships part. */
export const buildRelsXml = (rels: readonly OoxmlRelationship[]): string => {
  const body = rels
    .map(
      (r) =>
        `<Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}" Target="${escapeXml(r.target)}"/>`,
    )
    .join("")
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

/** A `[Content_Types].xml` entry — either an extension default or a part override. */
export type ContentTypeDecl =
  | { readonly kind: "default"; readonly extension: string; readonly contentType: string }
  | { readonly kind: "override"; readonly partName: string; readonly contentType: string }

/** Serialize the package `[Content_Types].xml` part. */
export const buildContentTypesXml = (decls: readonly ContentTypeDecl[]): string => {
  const body = decls
    .map((d) =>
      d.kind === "default"
        ? `<Default Extension="${escapeXml(d.extension)}" ContentType="${escapeXml(d.contentType)}"/>`
        : `<Override PartName="${escapeXml(d.partName)}" ContentType="${escapeXml(d.contentType)}"/>`,
    )
    .join("")
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${body}</Types>`
}

/** The standard package-root relationship type for the main document part. */
export const REL_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
