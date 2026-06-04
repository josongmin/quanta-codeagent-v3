/**
 * H14b — minimal-but-VALID `.docx` (WordprocessingML) serializer.
 *
 * Produces a document Word / LibreOffice / Google Docs open cleanly, from these
 * spec-minimal parts (ECMA-376 / ISO 29500 Part 1):
 *   - `[Content_Types].xml`          — part MIME types
 *   - `_rels/.rels`                  — package → document
 *   - `word/document.xml`            — the body (paragraphs + runs)
 *   - `word/_rels/document.xml.rels` — document relationships (empty but valid;
 *                                      Word expects the part to exist)
 *
 * Content model: a flat list of {@link DocxParagraph}. A paragraph is either a
 * HEADING (level 1–6, mapped to a Word built-in `Heading{N}` style) or a body
 * paragraph composed of one or more RUNS. A run carries text plus optional
 * `bold`/`italic` toggles. That covers the "reports" deliverable shape (titles,
 * section headings, prose, simple emphasis) without dragging in a styles part
 * (Word renders `Heading{N}` / `Title` from its built-in style gallery, and a
 * paragraph with no explicit style uses Normal).
 *
 * Pure: `buildDocx(spec) => Uint8Array`. No clock, no randomness, no FS.
 */

import { buildContentTypesXml, buildRelsXml, REL_OFFICE_DOCUMENT, XML_DECL, xmlText } from "./ooxml"
import { buildStoredZip, textEntry, type ZipEntry } from "./zip-store"

/** A formatted text run within a paragraph. */
export interface DocxRun {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
}

/** A paragraph: either a heading (level 1–6) or a body paragraph of runs. */
export type DocxParagraph =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly runs: readonly DocxRun[] }

export interface DocxSpec {
  readonly paragraphs: readonly DocxParagraph[]
}

/** Word built-in heading style id for a 1–6 level (clamped). `Heading1`..`Heading6`. */
const headingStyleId = (level: number): string => {
  const n = Math.min(6, Math.max(1, Math.trunc(level) || 1))
  return `Heading${n}`
}

const runXml = (run: DocxRun): string => {
  const props: string[] = []
  if (run.bold === true) props.push("<w:b/>")
  if (run.italic === true) props.push("<w:i/>")
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : ""
  // xml:space="preserve" keeps leading/trailing spaces (Word trims otherwise).
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlText(run.text)}</w:t></w:r>`
}

const paragraphXml = (p: DocxParagraph): string => {
  if (p.kind === "heading") {
    return (
      `<w:p><w:pPr><w:pStyle w:val="${headingStyleId(p.level)}"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">${xmlText(p.text)}</w:t></w:r></w:p>`
    )
  }
  const runs = p.runs.map(runXml).join("")
  return `<w:p>${runs}</w:p>`
}

const buildDocumentXml = (paragraphs: readonly DocxParagraph[]): string => {
  // Word requires a non-empty body; an empty doc still needs ONE empty <w:p>.
  const body = paragraphs.length > 0 ? paragraphs.map(paragraphXml).join("") : "<w:p/>"
  return (
    `${XML_DECL}` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}` +
    // sectPr closes the single section — present in every well-formed document.
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`
  )
}

const CT_DOCUMENT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"

/**
 * Serialize a {@link DocxSpec} to `.docx` bytes. An empty spec yields a valid
 * single-empty-paragraph document. Pure + deterministic.
 */
export const buildDocx = (spec: DocxSpec): Uint8Array => {
  const contentTypes = buildContentTypesXml([
    {
      kind: "default",
      extension: "rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
    },
    { kind: "default", extension: "xml", contentType: "application/xml" },
    { kind: "override", partName: "/word/document.xml", contentType: CT_DOCUMENT },
  ])
  const packageRels = buildRelsXml([
    { id: "rId1", type: REL_OFFICE_DOCUMENT, target: "word/document.xml" },
  ])
  // Word expects word/_rels/document.xml.rels to exist even with no relationships.
  const documentRels = buildRelsXml([])

  const entries: ZipEntry[] = [
    textEntry("[Content_Types].xml", contentTypes),
    textEntry("_rels/.rels", packageRels),
    textEntry("word/document.xml", buildDocumentXml(spec.paragraphs)),
    textEntry("word/_rels/document.xml.rels", documentRels),
  ]
  return buildStoredZip(entries)
}
