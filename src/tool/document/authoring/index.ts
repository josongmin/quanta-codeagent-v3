/**
 * H14b — Office document AUTHORING slice barrel.
 *
 * Opens a NEW tool category alongside H14a `image_gen`: generating real binary
 * Office files (`.xlsx`, `.docx`) with ZERO dependencies — pure-TS STORED-ZIP +
 * OOXML serialization. Installs are blocked and there is no office library, so
 * the whole stack (CRC-32, stored-ZIP container, OOXML parts) is built by hand.
 *
 * Exports:
 *   - Pure cores: `crc32` / `buildStoredZip` / `parseStoredZip` (ZIP),
 *     `buildXlsx` / `buildDocx` (OOXML serializers), the OOXML XML helpers.
 *   - Tools: `xlsxWriteTool` (`xlsx_write`) + `docxWriteTool` (`docx_write`),
 *     registered conditionally via `DefaultToolPorts.officeAuthoring`
 *     (default-OFF — see `src/tool/index.ts`).
 *
 * PPTX authoring is a SCOPED FOLLOW-UP (the STORED-ZIP + OOXML core here is the
 * shared substrate a future `pptx_write` reuses — only a PresentationML
 * serializer remains). Deliberately not half-baked in this slice.
 */

export { buildDocx, type DocxParagraph, type DocxRun, type DocxSpec } from "./docx"
export {
  DOCX_WRITE_MAX_PARAGRAPHS,
  DOCX_WRITE_MAX_RUNS_PER_PARAGRAPH,
  type DocxWriteInput,
  docxWriteInputSchema,
  docxWriteTool,
} from "./docx-write"
export {
  type JailedTargetResult,
  resolveVersionedJailedTarget,
  writeJailedBytes,
} from "./jailed-write"
export {
  buildContentTypesXml,
  buildRelsXml,
  type ContentTypeDecl,
  escapeXml,
  type OoxmlRelationship,
  REL_OFFICE_DOCUMENT,
  stripIllegalXmlChars,
  XML_DECL,
  xmlText,
} from "./ooxml"
export {
  buildXlsx,
  columnLetter,
  sanitizeSheetName,
  type XlsxCellValue,
  type XlsxSheetSpec,
  type XlsxSpec,
} from "./xlsx"
export {
  XLSX_WRITE_MAX_COLS_PER_ROW,
  XLSX_WRITE_MAX_ROWS_PER_SHEET,
  XLSX_WRITE_MAX_SHEETS,
  type XlsxWriteInput,
  xlsxWriteInputSchema,
  xlsxWriteTool,
} from "./xlsx-write"
export {
  buildStoredZip,
  crc32,
  type ParsedZipEntry,
  parseStoredZip,
  textEntry,
  type ZipEntry,
} from "./zip-store"
