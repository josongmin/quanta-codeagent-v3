/**
 * Vendor-detector barrel — multi-source rules auto-detect (S2).
 *
 * Detects rule files from 6 sources (cursor / cline / roo / aider / windsurf
 * / quanta) and normalizes them into a single `DetectedRule` shape. The
 * consumer (`@/agent/glob-rules.ts` and friends) converts these to its own
 * `GlobRule` shape if needed — this slice does not reach into `@/agent`.
 *
 * Slice fence: `@/rules` may import `@/shared` only. This barrel exposes
 * NOTHING that depends on `@/agent` / `@/skill`. The detector reads files
 * via `node:fs/promises` directly (node builtins are slice-fence-exempt).
 *
 * Default-OFF posture: callers that do not invoke `detectAll` see byte-
 * identical legacy behaviour. The existing `loadGlobRules` path in
 * `@/agent/glob-rules.ts` is untouched; this is an additive seam.
 */

export { createDefaultVendorDetector, DEFAULT_MAX_FILES } from "./default-detector"
export { DEFAULT_MAX_BODY_BYTES, normalizeOne, resolveCollisions } from "./normalizer"
export type {
  DetectedRule,
  DetectionResult,
  DetectOptions,
  DetectorError,
  RuleScope,
  RuleTrigger,
  VendorDetectorPort,
  VendorId,
} from "./port"
export type { ParserKind, PathEntry, PathKind, VendorDescriptor } from "./vendor-table"
export { VENDOR_PRIORITY, VENDOR_TABLE } from "./vendor-table"
