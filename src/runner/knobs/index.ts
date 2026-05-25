/**
 * `@/runner/knobs` — SOTA++ knob framework public barrel.
 *
 * Consumers import the public types + the four functional seams:
 *   - `registerKnob` / `knobsForSurface` / `allKnobs` (registry)
 *   - `resolveKnobs` (layered resolution)
 *   - `applyKnobs` (fold over AgentConfig)
 *   - `validateKnobs` (relationship checks; called inside resolveKnobs)
 *   - `readKnobConfig` / `writeKnobConfig` (user defaults persistence)
 *   - `KNOB_PRESETS` (named bundles)
 */

export { applyKnobs } from "./apply"
export { type KnobConfigFile, readKnobConfig, writeKnobConfig } from "./persist"
export { KNOB_PRESETS } from "./presets"
export { __resetRegistry, allKnobs, knobsForSurface, registerKnob } from "./registry"
export { resolveKnobs } from "./resolve"
export {
  type AnyKnob,
  type ApplyContext,
  asAnyKnob,
  type Knob,
  type KnobCategory,
  KnobConflictError,
  KnobMissingRequiredError,
  KnobParseError,
  type KnobValue,
  type KnobValueMap,
  type ResolveArgs,
  type Surface,
} from "./types"
export { validateKnobs } from "./validate"
