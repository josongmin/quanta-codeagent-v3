/**
 * Document tool slice barrel (ADR-0133 / ADR-0137 — structured-data + native-
 * document tools).
 *
 * Exports five tools (`csv_read`, `ndjson_read`, `yaml_read`, `pdf_read`,
 * `xlsx_read` stub) and their pure parsers. Registration is DEFERRED —
 * exported here but NOT added to `defaultTools` until the
 * `MUTATING_TOOL_TABLE` (sibling-touched) absorbs the new entries. Same
 * posture as `read_image` (ADR-0126) and `web_fetch` / `web_search`
 * (ADR-0127).
 */

export {
  type CsvCell,
  type CsvParseDiagnostic,
  type CsvParseOpts,
  type CsvParseResult,
  CsvParserInputError,
  type CsvRow,
  parseCsv,
} from "./csv-parse"
export {
  CSV_READ_DEFAULT_MAX_ROWS,
  CSV_READ_MAX_OUTPUT,
  CSV_READ_MAX_ROWS_CEILING,
  type CsvReadInput,
  csvReadInputSchema,
  csvReadTool,
} from "./csv-read"
export {
  type NdjsonLine,
  type NdjsonParseResult,
  NdjsonParserInputError,
  parseNdjson,
} from "./ndjson-parse"
export {
  NDJSON_READ_DEFAULT_MAX_LINES,
  NDJSON_READ_MAX_LINES_CEILING,
  NDJSON_READ_MAX_OUTPUT,
  type NdjsonReadInput,
  ndjsonReadInputSchema,
  ndjsonReadTool,
} from "./ndjson-read"
export {
  MAX_PDF_BYTES,
  PDF_MEDIA_TYPE,
  pdfReadTool,
  type ReadPdfInput,
  readPdfInputSchema,
  type SupportedDocumentMediaType,
  sniffPdfMagic,
} from "./pdf-read"
export {
  XLSX_READ_DEFERRAL_MESSAGE,
  type XlsxReadInput,
  xlsxReadInputSchema,
  xlsxReadTool,
} from "./xlsx-read"
export {
  YAML_READ_DEFAULT_MAX_KEYS,
  YAML_READ_MAX_KEYS_CEILING,
  YAML_READ_MAX_OUTPUT,
  type YamlReadInput,
  yamlReadInputSchema,
  yamlReadTool,
} from "./yaml-read"
