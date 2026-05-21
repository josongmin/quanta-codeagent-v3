/**
 * Security module barrel (ADR-0078). Public surface for the agent loop
 * and dispatch seam to consume.
 */
export type {
  RedactionKind,
  RedactionHit,
  RedactionOrigin,
  RedactOptions,
  RedactResult,
} from "./redaction"
export { redactSecrets, assertKindWired } from "./redaction"
export type { SensitivityClass } from "./sensitivity-classifier"
export { classifyPath, classifyCommandShape } from "./sensitivity-classifier"
export type { RedactionConfig, NormalizedRedactionConfig } from "./redaction-config"
export {
  normalizeRedactionConfig,
  RedactionConfigError,
  REDACTION_DISABLED_WITHOUT_ACK_MESSAGE,
} from "./redaction-config"
