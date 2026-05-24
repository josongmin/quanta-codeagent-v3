/**
 * PII-redaction barrel (ADR-0171). Public surface for callers (jsonl
 * recorder, telemetry sink, prompt logger). Nothing in the dispatch / loop
 * seam imports this — default-OFF until a caller opts in.
 */
export { compositePiiScanner } from "./composite-scanner"
export { isLuhnValid } from "./luhn-validator"
export { runPatterns as runPiiPatterns } from "./pattern-scanner"
export {
  ALL_PII_KINDS,
  DEFAULT_REDACTION_TEMPLATES,
  type PiiFinding,
  type PiiKind,
  type PiiScanner,
  type PiiScannerOpts,
} from "./port"
