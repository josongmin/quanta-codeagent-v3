/**
 * H14 (PPTX follow-up) — minimal-but-VALID `.pptx` (PresentationML) serializer.
 *
 * The third Office authoring format, mirroring {@link buildXlsx} / {@link buildDocx}:
 * a pure `spec → Uint8Array` serializer built on the SAME dependency-free
 * STORED-ZIP container ({@link buildStoredZip}) + OOXML primitives ({@link xmlText}).
 * NO office dependency (installs are blocked) — every PresentationML part is
 * emitted BY HAND.
 *
 * Workflow intent (absorbed from Codex's `Presentations` skill, whose own
 * artifact-tool JSX runtime is NOT portable): an EDITABLE deck of ordered
 * slides, each carrying a TITLE (the slide's claim) + a BODY of bullet lines
 * (the proof). That maps to {@link PptxSlide} = `{ title?, body?[] }` and a deck
 * to {@link PptxSpec} = `{ slides }`. We deliberately target real ISO-29500
 * PresentationML rather than a bespoke format so PowerPoint / LibreOffice open
 * the file.
 *
 * Spec-minimal parts (ECMA-376 / ISO 29500 Part 1, §19):
 *   - `[Content_Types].xml`                         — part MIME types
 *   - `_rels/.rels`                                 — package → presentation
 *   - `ppt/presentation.xml`                        — slide-master + slide id list
 *   - `ppt/_rels/presentation.xml.rels`             — presentation → master/slides/theme
 *   - `ppt/slideMasters/slideMaster1.xml` (+rels)   — the master (→ layout + theme)
 *   - `ppt/slideLayouts/slideLayout1.xml` (+rels)   — one blank layout (→ master)
 *   - `ppt/slides/slideN.xml` (+rels)               — one per slide (→ layout)
 *   - `ppt/theme/theme1.xml`                         — a minimal theme (color/font/format scheme)
 *
 * Each slide carries a TITLE placeholder shape + a BODY text-box shape; every
 * body line is one paragraph (one bullet). ALL user text is sanitized + escaped
 * via {@link xmlText} so a raw `<`/`&`/`"` can never break the XML.
 *
 * Pure + deterministic: no clock, no randomness, no FS. The EMU geometry
 * constants are fixed (a 10in × 7.5in / 4:3 deck — the PowerPoint default).
 */

import { buildContentTypesXml, buildRelsXml, XML_DECL, xmlText } from "./ooxml"
import { buildStoredZip, textEntry, type ZipEntry } from "./zip-store"

/** One slide: an optional title (claim) + optional body bullet lines (proof). */
export interface PptxSlide {
  /** The slide title (rendered in the title placeholder). Omitted ⇒ no title. */
  readonly title?: string
  /** Body bullet lines — one paragraph per entry. Omitted/empty ⇒ no body box. */
  readonly body?: readonly string[]
}

/** A deck: an ordered list of slides. An empty deck yields one blank slide. */
export interface PptxSpec {
  readonly slides: readonly PptxSlide[]
}

// ── relationship + content-type constants ────────────────────────────────────

const REL_SLIDE_MASTER =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
const REL_SLIDE_LAYOUT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
const REL_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
const REL_PRESENTATION =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"

const CT_PRESENTATION =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
const CT_SLIDE_MASTER =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"
const CT_SLIDE_LAYOUT =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
const CT_THEME = "application/vnd.openxmlformats-officedocument.theme+xml"

// Namespace declarations shared by the DrawingML-bearing parts. `p:` =
// PresentationML, `a:` = DrawingML, `r:` = relationships.
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

// 4:3 slide geometry in EMU (1 in = 914400 EMU). 10in × 7.5in — PowerPoint's
// historical default. Fixed (no clock / no randomness) for determinism.
const SLIDE_W = 9144000
const SLIDE_H = 6858000

// ── DrawingML shape helpers ──────────────────────────────────────────────────

/** A text-box `<p:sp>` placed at (x,y) with size (cx,cy), holding the given
 *  paragraphs (already XML-escaped). `idx` is the unique shape id within a slide. */
const textShape = (
  id: number,
  name: string,
  placeholderType: string | undefined,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: readonly string[],
): string => {
  // A title/body placeholder carries an <p:ph> so the layout binds it; a plain
  // text box omits it. We keep both paths so an empty-title slide still has a
  // valid body box.
  const ph = placeholderType === undefined ? "" : `<p:ph type="${placeholderType}"/>`
  // Each paragraph is one <a:p>; an empty body still needs ≥1 <a:p> so the box
  // is well-formed. Empty paragraphs render as a blank line (valid).
  const paras =
    paragraphs.length > 0
      ? paragraphs
          .map((t) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${t}</a:t></a:r></a:p>`)
          .join("")
      : '<a:p><a:endParaRPr lang="en-US"/></a:p>'
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${id}" name="${xmlText(name)}"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr>${ph}</p:nvPr>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `</p:spPr>` +
    `<p:txBody>` +
    `<a:bodyPr/><a:lstStyle/>${paras}` +
    `</p:txBody>` +
    `</p:sp>`
  )
}

// ── per-slide XML ─────────────────────────────────────────────────────────────

const buildSlideXml = (slide: PptxSlide): string => {
  const shapes: string[] = []
  let shapeId = 2 // 1 is reserved for the group shape below.

  // Title shape (top band). Always present so a layout's title placeholder
  // binds; an absent title is an empty placeholder (valid).
  const title = slide.title ?? ""
  shapes.push(
    textShape(shapeId++, "Title 1", "title", 685800, 457200, 7772400, 1143000, [xmlText(title)]),
  )

  // Body shape (one paragraph per bullet line). Only when there is body text —
  // but we still emit a body placeholder so the slide layout is honored; an
  // empty body becomes a single empty paragraph.
  const body = (slide.body ?? []).map((line) => xmlText(line))
  shapes.push(textShape(shapeId++, "Content 2", "body", 685800, 1828800, 7772400, 4351338, body))

  return (
    `${XML_DECL}` +
    `<p:sld ${NS_A} ${NS_R} ${NS_P}>` +
    `<p:cSld>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>` +
    `</p:grpSpPr>` +
    `${shapes.join("")}` +
    `</p:spTree>` +
    `</p:cSld>` +
    `<p:clrMapOvr><a:overrideClrMapping ` +
    `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
    `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ` +
    `hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>` +
    `</p:sld>`
  )
}

// ── slide master / layout / theme (fixed scaffold) ───────────────────────────

const buildSlideMasterXml = (): string =>
  `${XML_DECL}` +
  `<p:sldMaster ${NS_A} ${NS_R} ${NS_P}>` +
  `<p:cSld>` +
  `<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
  `<p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr>` +
  `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>` +
  `</p:grpSpPr>` +
  `</p:spTree>` +
  `</p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
  `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ` +
  `hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles>` +
  `<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle>` +
  `<p:otherStyle/>` +
  `</p:txStyles>` +
  `</p:sldMaster>`

const buildSlideLayoutXml = (): string =>
  `${XML_DECL}` +
  `<p:sldLayout ${NS_A} ${NS_R} ${NS_P} type="obj" preserve="1">` +
  `<p:cSld name="Title and Content">` +
  `<p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr>` +
  `<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
  `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>` +
  `</p:grpSpPr>` +
  `</p:spTree>` +
  `</p:cSld>` +
  `<p:clrMapOvr><a:overrideClrMapping ` +
  `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
  `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ` +
  `hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>` +
  `</p:sldLayout>`

// A minimal-but-valid theme: themeElements MUST carry a clrScheme (12 colors),
// a fontScheme (major+minor), and a fmtScheme (fill/line/effect/bg style lists).
// PowerPoint rejects a theme missing any of these, so we emit the canonical
// minimal set Office itself writes for a blank deck.
const buildThemeXml = (): string => {
  const color = (tag: string, hex: string): string =>
    `<a:${tag}><a:srgbClr val="${hex}"/></a:${tag}>`
  const sysColor = (tag: string, val: string, hex: string): string =>
    `<a:${tag}><a:sysClr val="${val}" lastClr="${hex}"/></a:${tag}>`
  const clrScheme =
    `<a:clrScheme name="Office">` +
    sysColor("dk1", "windowText", "000000") +
    sysColor("lt1", "window", "FFFFFF") +
    color("dk2", "44546A") +
    color("lt2", "E7E6E6") +
    color("accent1", "4472C4") +
    color("accent2", "ED7D31") +
    color("accent3", "A5A5A5") +
    color("accent4", "FFC000") +
    color("accent5", "5B9BD5") +
    color("accent6", "70AD47") +
    color("hlink", "0563C1") +
    color("folHlink", "954F72") +
    `</a:clrScheme>`
  const fontScheme =
    `<a:fontScheme name="Office">` +
    `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>`
  // A schemeClr-fill / solid-line / no-effect / solid-bg minimal fmtScheme.
  const solidFill = (ref: string): string =>
    `<a:solidFill><a:schemeClr val="${ref}"/></a:solidFill>`
  const fmtScheme =
    `<a:fmtScheme name="Office">` +
    `<a:fillStyleLst>${solidFill("phClr")}${solidFill("phClr")}${solidFill("phClr")}</a:fillStyleLst>` +
    `<a:lnStyleLst>` +
    `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">${solidFill("phClr")}<a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">${solidFill("phClr")}<a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr">${solidFill("phClr")}<a:prstDash val="solid"/></a:ln>` +
    `</a:lnStyleLst>` +
    `<a:effectStyleLst>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${solidFill("phClr")}${solidFill("phClr")}${solidFill("phClr")}</a:bgFillStyleLst>` +
    `</a:fmtScheme>`
  return (
    `${XML_DECL}` +
    `<a:theme ${NS_A} name="Office Theme">` +
    `<a:themeElements>${clrScheme}${fontScheme}${fmtScheme}</a:themeElements>` +
    `<a:objectDefaults/><a:extraClrSchemeLst/>` +
    `</a:theme>`
  )
}

const buildPresentationXml = (slideCount: number): string => {
  // sldMasterId references rId1 (the master); each slide gets rId(N+1).
  const sldIds: string[] = []
  for (let i = 0; i < slideCount; i++) {
    // sldId @id MUST be ≥256 and unique.
    sldIds.push(`<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
  }
  return (
    `${XML_DECL}` +
    `<p:presentation ${NS_A} ${NS_R} ${NS_P} saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen4x3"/>` +
    `<p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>` +
    `</p:presentation>`
  )
}

/**
 * Serialize a {@link PptxSpec} to `.pptx` bytes. Always produces ≥1 slide (an
 * empty spec yields one blank slide — PowerPoint rejects a zero-slide deck) plus
 * the master/layout/theme scaffold. Pure + deterministic.
 */
export const buildPptx = (spec: PptxSpec): Uint8Array => {
  const slides = spec.slides.length > 0 ? spec.slides : [{} as PptxSlide]
  const slideCount = slides.length

  // ── [Content_Types].xml ────────────────────────────────────────────────────
  const contentTypes = buildContentTypesXml([
    {
      kind: "default",
      extension: "rels",
      contentType: "application/vnd.openxmlformats-package.relationships+xml",
    },
    { kind: "default", extension: "xml", contentType: "application/xml" },
    { kind: "override", partName: "/ppt/presentation.xml", contentType: CT_PRESENTATION },
    {
      kind: "override",
      partName: "/ppt/slideMasters/slideMaster1.xml",
      contentType: CT_SLIDE_MASTER,
    },
    {
      kind: "override",
      partName: "/ppt/slideLayouts/slideLayout1.xml",
      contentType: CT_SLIDE_LAYOUT,
    },
    { kind: "override", partName: "/ppt/theme/theme1.xml", contentType: CT_THEME },
    ...slides.map((_, i) => ({
      kind: "override" as const,
      partName: `/ppt/slides/slide${i + 1}.xml`,
      contentType: CT_SLIDE,
    })),
  ])

  // ── package + presentation relationships ────────────────────────────────────
  const packageRels = buildRelsXml([
    { id: "rId1", type: REL_PRESENTATION, target: "ppt/presentation.xml" },
  ])

  // presentation.xml.rels: rId1 → master, rId(N+1) → slideN, then theme last.
  const presRels = [
    { id: "rId1", type: REL_SLIDE_MASTER, target: "slideMasters/slideMaster1.xml" },
    ...slides.map((_, i) => ({
      id: `rId${i + 2}`,
      type: REL_SLIDE,
      target: `slides/slide${i + 1}.xml`,
    })),
    { id: `rId${slideCount + 2}`, type: REL_THEME, target: "theme/theme1.xml" },
  ]

  // slideMaster1.xml.rels: rId1 → layout, rId2 → theme.
  const masterRels = buildRelsXml([
    { id: "rId1", type: REL_SLIDE_LAYOUT, target: "../slideLayouts/slideLayout1.xml" },
    { id: "rId2", type: REL_THEME, target: "../theme/theme1.xml" },
  ])

  // slideLayout1.xml.rels: rId1 → master.
  const layoutRels = buildRelsXml([
    { id: "rId1", type: REL_SLIDE_MASTER, target: "../slideMasters/slideMaster1.xml" },
  ])

  // ── assemble ────────────────────────────────────────────────────────────────
  const entries: ZipEntry[] = [
    textEntry("[Content_Types].xml", contentTypes),
    textEntry("_rels/.rels", packageRels),
    textEntry("ppt/presentation.xml", buildPresentationXml(slideCount)),
    textEntry("ppt/_rels/presentation.xml.rels", buildRelsXml(presRels)),
    textEntry("ppt/slideMasters/slideMaster1.xml", buildSlideMasterXml()),
    textEntry("ppt/slideMasters/_rels/slideMaster1.xml.rels", masterRels),
    textEntry("ppt/slideLayouts/slideLayout1.xml", buildSlideLayoutXml()),
    textEntry("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layoutRels),
    textEntry("ppt/theme/theme1.xml", buildThemeXml()),
    ...slides.map((s, i) => textEntry(`ppt/slides/slide${i + 1}.xml`, buildSlideXml(s))),
    // Each slide's rels → the single shared layout (rId1).
    ...slides.map((_, i) =>
      textEntry(
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        buildRelsXml([
          { id: "rId1", type: REL_SLIDE_LAYOUT, target: "../slideLayouts/slideLayout1.xml" },
        ]),
      ),
    ),
  ]
  return buildStoredZip(entries)
}
