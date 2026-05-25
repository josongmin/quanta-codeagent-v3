/** System-prompt mode-variant slice barrel (ADR-0211). */
export {
  type BuildSystemPromptForModeOpts,
  buildSystemPromptForMode,
  defaultModeVariantRegistry,
} from "./default-builder"
export { DEFAULT_MODE_VARIANTS, UNKNOWN_MODE_VARIANT } from "./mode-variants"
export {
  assertValidVariantLines,
  MODE_VARIANT_KEYS,
  type ModeVariant,
  type ModeVariantKey,
  ModeVariantLineError,
  type SystemPromptVariantRegistry,
} from "./port"
