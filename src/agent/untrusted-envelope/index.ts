/**
 * untrusted-source-envelope — public barrel (ADR-0471).
 *
 * WHAT: re-exports the slice's public surface for the composition root.
 * ADR: 0471 (untrusted-source-envelope)
 * SLICES IMPORTED: sibling modules only.
 * NO-THROW: re-export only.
 */

export { UNTRUSTED_ENVELOPE_ENV, untrustedEnvelopeEnabled } from "./gate"
export {
  UNTRUSTED_ENVELOPE_RULE,
  UNTRUSTED_ENVELOPE_SECTION_NAME,
} from "./rule"
export {
  isUntrusted,
  TRUSTED_SOURCES,
  UNTRUSTED_SOURCES,
  type UntrustedSource,
} from "./types"
export { defangEnvelopeTags, ENVELOPE_TAG, type WrapOptions, wrapToolResult } from "./wrap"
