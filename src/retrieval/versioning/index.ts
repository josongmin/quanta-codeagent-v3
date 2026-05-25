/**
 * `@/retrieval/versioning` slice barrel — ADR-0266.
 *
 * Public surface:
 *   - Types       : `ModelTag`, `InvalidationDecision`, `ParseError`
 *   - Ports       : `ModelTagger`, `Invalidator`, `InvalidationCallback`,
 *                   `ModelTagInput`
 *   - Codec       : `defaultModelTagger`, `tagModel`, `parseModelTag`,
 *                   `canonicalString`
 *   - Invalidator : `createDefaultInvalidator`, `checkInvalidation`,
 *                   `DefaultInvalidatorOptions`
 *   - Registry    : `registerInvalidationCallback`,
 *                   `listInvalidationCallbacks`,
 *                   `clearInvalidationCallbacks` (test-only)
 *
 * Default-OFF: importing this barrel does nothing observable. The cache
 * + index layers MUST explicitly construct an `Invalidator` and register
 * callbacks for the slice to alter behaviour.
 */

export {
  checkInvalidation,
  createDefaultInvalidator,
  type DefaultInvalidatorOptions,
} from "./invalidator"
export type {
  InvalidationCallback,
  Invalidator,
  ModelTagger,
  ModelTagInput,
} from "./port"
export {
  clearInvalidationCallbacks,
  listInvalidationCallbacks,
  registerInvalidationCallback,
} from "./registry-callbacks"
export {
  canonicalString,
  defaultModelTagger,
  parseModelTag,
  tagModel,
} from "./tag-codec"
export type { InvalidationDecision, ModelTag, ParseError } from "./types"
