/**
 * `@/runner/knobs` — SOTA++ knob framework public barrel.
 *
 * Consumers import the public types + the four functional seams:
 *   - `registerKnob` / `knobsForSurface` / `allKnobs` (registry)
 *   - `resolveKnobs` (layered resolution)
 *   - `applyKnobs` (fold over AgentConfig)
 *   - `validateKnobs` (relationship checks; called inside resolveKnobs)
 *   - `readKnobConfig` / `writeKnobConfig` / `saveKnobConfigMerged`
 *     (user defaults persistence; surfaces save via the MERGING helper)
 *   - `KNOB_PRESETS` (named bundles)
 */

export { applyKnobs } from "./apply"
export {
  type KnobConfigFile,
  readKnobConfig,
  saveKnobConfigMerged,
  writeKnobConfig,
} from "./persist"
export { KNOB_PRESETS, presetRequiresLiveLspGrounding } from "./presets"
export {
  __resetRegistry,
  __restoreRegistry,
  __snapshotRegistry,
  allKnobs,
  knobsForSurface,
  registerKnob,
} from "./registry"
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
