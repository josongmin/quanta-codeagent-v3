/**
 * Prefix-rule allowlist DSL — barrel.
 *
 * This slice is consumed by the admissibility-gate (per ADR-0031). Callers
 * SHOULD import from `./index` (or `@/rules` when the path alias is added)
 * and NOT reach into individual sub-modules — the barrel is the public
 * contract.
 */

export { matchCommand } from "./matcher"
export { parseRules } from "./parser"
export type { RulesSnapshot } from "./store"
export { RulesStore } from "./store"
export type { MatchOutcome, Rule, RuleAction, RuleLayer } from "./types"
export { RuleConflictError, RuleParseError } from "./types"

// ─── Multi-source rules vendor-detector (ADR-0205) ──────────────────────────
// Detects rule files from 6 vendor sources (cursor / cline / roo / aider /
// windsurf / quanta) and normalizes them into a single `DetectedRule` shape.
// Default-OFF: only callers that explicitly invoke `createDefaultVendorDetector`
// see any behaviour change.
export type {
  DetectedRule,
  DetectionResult,
  DetectOptions,
  DetectorError,
  ParserKind,
  PathEntry,
  PathKind,
  RuleScope,
  RuleTrigger,
  VendorDescriptor,
  VendorDetectorPort,
  VendorId,
} from "./vendor-detector"
export {
  createDefaultVendorDetector,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_FILES,
  normalizeOne,
  resolveCollisions,
  VENDOR_PRIORITY,
  VENDOR_TABLE,
} from "./vendor-detector"
