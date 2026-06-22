/**
 * Preset ⇄ composite SSOT relationship (jun-22 v5, D2 collapse).
 *
 * The thin-strict preset FAMILY and the v5 capability composites encode the SAME
 * "this capability = these knobs" data. They cannot be one physical source:
 *   - the shipped presets in `runner/knobs/presets.ts` are deliberately FROZEN
 *     IMMUTABLE LITERALS (a result tagged `preset:agentless-v4-proof-clean` must
 *     mean the same thing forever + be auditable as a literal; the
 *     `bench-preset-drives-config-hellgate` snapshot trips on any in-place edit);
 *   - the composites in `capability-profiles.ts` add GROUPING structure (named
 *     capability modules) that a flat preset lacks and v5 needs to attach/detach
 *     per phase.
 *
 * So neither can be DERIVED from the other without losing freeze (preset→literal)
 * or grouping (module→named). The honest SSOT design is therefore:
 *   - the capability MODULES are the conceptual VALUE source (change a module and
 *     the identity test below fails until the frozen literal is updated to match,
 *     so the modules drive);
 *   - the frozen preset literal is a reproducibility-pinned CACHE of the fold.
 *
 * `composePresetKnobs` is the single named relationship (fold a composite onto a
 * base → the flat preset knob map). {@link PRESET_COMPOSITES} declares which
 * composite each shipped preset must equal. The identity hellgate pins
 * `KNOB_PRESETS[name] === composePresetKnobs(THIN_STRICT_BASE, composite)` raw,
 * so the two physical copies can never drift (stronger than the prior
 * behavioral-equivalence — it pins the raw knob values byte-for-byte).
 */

import { KNOB_PRESETS } from "@/runner/knobs/presets"
import {
  CLOSURE_SELECT_CLEAN_MODULES,
  GATED_MODULES,
  PROOF_CLEAN_MODULES,
  SELECT_MODULES,
} from "./capability-profiles"
import type { KnobModule } from "./knob-module"

/** The shared base every composable thin-strict preset folds onto. */
export const THIN_STRICT_PRESET = "agentless-v3-thin-strict"

/** Fold a composite (ordered modules; later wins) onto a base raw-knob map and
 *  serialize to the flat `knob-id → raw` shape a preset literal uses. Pure. */
export const composePresetKnobs = (
  base: Readonly<Record<string, string>>,
  modules: readonly KnobModule[],
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = { ...base }
  for (const m of modules) {
    for (const [knobId, raw] of Object.entries(m.knobs)) out[knobId] = raw
  }
  return out
}

/** Each shipped composable preset and the composite it MUST equal (the SSOT
 *  contract the identity hellgate enforces). The frozen literal is the cache;
 *  the composite is the conceptual value source. */
export const PRESET_COMPOSITES: readonly {
  readonly preset: string
  readonly modules: readonly KnobModule[]
}[] = [
  { preset: "agentless-v3-thin-strict-gated", modules: GATED_MODULES },
  { preset: "agentless-v3-thin-strict-select", modules: SELECT_MODULES },
  { preset: "agentless-v3-thin-strict-closure-select-clean", modules: CLOSURE_SELECT_CLEAN_MODULES },
  { preset: "agentless-v4-proof-clean", modules: PROOF_CLEAN_MODULES },
]

/** The composed knob map for a declared preset (the value its frozen literal is
 *  pinned to). Throws if the preset is not a known composite. */
export const composedKnobsForPreset = (preset: string): Readonly<Record<string, string>> => {
  const entry = PRESET_COMPOSITES.find((c) => c.preset === preset)
  if (entry === undefined) throw new Error(`no composite declared for preset "${preset}"`)
  return composePresetKnobs(KNOB_PRESETS[THIN_STRICT_PRESET] ?? {}, entry.modules)
}
