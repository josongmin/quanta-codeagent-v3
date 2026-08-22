/**
 * Security module barrel (ADR-0078). Public surface for the agent loop
 * and dispatch seam to consume.
 */
export type {
  RedactionHit,
  RedactionKind,
  RedactionOrigin,
  RedactOptions,
  RedactResult,
} from "./redaction"
export { assertKindWired, redactSecrets } from "./redaction"
export type {
  NormalizedRedactionConfig,
  PiiRedactionConfig,
  RedactionConfig,
} from "./redaction-config"
export {
  normalizeRedactionConfig,
  REDACTION_DISABLED_WITHOUT_ACK_MESSAGE,
  RedactionConfigError,
} from "./redaction-config"
export type { SensitivityClass } from "./sensitivity-classifier"
export { classifyCommandShape, classifyPath } from "./sensitivity-classifier"
