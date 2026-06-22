/**
 * Preset ⇄ composite SSOT relationship (jun-22 v5, D2 collapse + P2 superset).
 *
 * The composable preset FAMILY and the v5 capability composites encode the SAME
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
 * `composePresetKnobs` is the SINGLE named fold (composite onto a base → flat
 * preset knob map); the SAME fold runs at runtime as `derivePhasePosture`.
 * {@link PRESET_COMPOSITES} is the SINGLE registry declaring which (base, modules)
 * each shipped composable preset must equal. The identity hellgate pins
 * `KNOB_PRESETS[name] === composePresetKnobs(base, modules)` raw, byte-for-byte,
 * so the two physical copies can never drift. Covers the WHOLE composable family
 * over its three frozen bases (v1 / v3-thin / v3-thin-strict); only true
 * subtractions / legacy literals (baseline, v1, v2, v2-safe, full, hint-only,
 * everything) are excluded.
 */

import { KNOB_PRESETS } from "@/runner/knobs/presets"
import {
  CLEAN_SELECTOR,
  CLOSURE_GROUNDING,
  CLOSURE_REPAIR,
  CLOSURE_SELECT_CLEAN_MODULES,
  COUNTERFACTUAL,
  GATED_MODULES,
  LLM_RISK_GATE,
  LOCALIZATION_CORE,
  MULTI_AGENT,
  PATCH_HYGIENE,
  PROOF_CLEAN_MODULES,
  REGRESSION,
  REPRO_DOUBT,
  REPRO_VOTE,
  RISK_GATE,
  ROUND0_MINIMAL,
  SELECT_EARLY_ACCEPT,
  SELECT_MODULES,
  SELECT_N,
  SELECT_REPRO_OFF,
  SELECT_REPRO_POSITIVE,
  STEER_OFF,
  THIN_BASE,
  THIN_STRICT_BASE,
} from "./capability-profiles"
import type { KnobModule } from "./knob-module"

/** The shared thin-strict base name (kept for back-compat with existing callers). */
export const THIN_STRICT_PRESET = "agentless-v3-thin-strict"

/** Fold a composite (ordered modules; later wins) onto a base raw-knob map and
 *  serialize to the flat `knob-id → raw` shape a preset literal uses. Pure. The
 *  build-time twin of the runtime `derivePhasePosture` fold. */
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

interface PresetComposite {
  readonly preset: string
  readonly base: Readonly<Record<string, string>>
  readonly modules: readonly KnobModule[]
}

/** Each shipped composable preset and the (base, composite) it MUST equal — the
 *  SINGLE SSOT registry the identity hellgate enforces. The frozen literal is the
 *  cache; the (base, modules) is the conceptual value source. */
export const PRESET_COMPOSITES: readonly PresetComposite[] = [
  // ── localization-core (agentless-v1) base ──
  { preset: "agentless-v1-nosteer", base: LOCALIZATION_CORE.knobs, modules: [STEER_OFF] },
  {
    preset: "agentless-mini-parity",
    base: LOCALIZATION_CORE.knobs,
    modules: [CLOSURE_GROUNDING, PATCH_HYGIENE, ROUND0_MINIMAL],
  },
  { preset: "everything-v1", base: LOCALIZATION_CORE.knobs, modules: [MULTI_AGENT] },
  {
    preset: "agentless-v2-repair",
    base: LOCALIZATION_CORE.knobs,
    modules: [CLOSURE_GROUNDING, PATCH_HYGIENE, CLOSURE_REPAIR(3)],
  },
  {
    preset: "agentless-v2-reprovote",
    base: LOCALIZATION_CORE.knobs,
    modules: [CLOSURE_GROUNDING, PATCH_HYGIENE, CLOSURE_REPAIR(3), REPRO_VOTE],
  },
  // ── base-as-self (identity) ──
  { preset: "agentless-v3-thin", base: THIN_BASE.knobs, modules: [] },
  { preset: "agentless-v3-thin-strict", base: THIN_STRICT_BASE.knobs, modules: [] },
  // v5 opening = the thin-strict base (the controller injects phase modules at
  // runtime, not into the preset literal).
  { preset: "agentless-v5-thin-and-expanded", base: THIN_STRICT_BASE.knobs, modules: [] },
  // ── thin-strict base — reuse the SAME composite arrays the controller routes to ──
  {
    preset: "agentless-v3-thin-strict-gated",
    base: THIN_STRICT_BASE.knobs,
    modules: GATED_MODULES,
  },
  {
    preset: "agentless-v3-thin-strict-select",
    base: THIN_STRICT_BASE.knobs,
    modules: SELECT_MODULES,
  },
  {
    preset: "agentless-v3-thin-strict-closure-select-clean",
    base: THIN_STRICT_BASE.knobs,
    modules: CLOSURE_SELECT_CLEAN_MODULES,
  },
  {
    preset: "agentless-v4-proof-clean",
    base: THIN_STRICT_BASE.knobs,
    modules: PROOF_CLEAN_MODULES,
  },
  // ── thin-strict research arms ──
  {
    preset: "agentless-v3-thin-strict-counterfactual",
    base: THIN_STRICT_BASE.knobs,
    modules: [...GATED_MODULES, COUNTERFACTUAL],
  },
  {
    preset: "agentless-v3-thin-strict-counterfactual-shadow",
    base: THIN_STRICT_BASE.knobs,
    modules: [...GATED_MODULES, COUNTERFACTUAL, LLM_RISK_GATE("shadow")],
  },
  {
    preset: "agentless-v3-thin-strict-gated-llm-shadow",
    base: THIN_STRICT_BASE.knobs,
    modules: [
      SELECT_N(2),
      REGRESSION("discovered"),
      RISK_GATE,
      SELECT_REPRO_OFF,
      LLM_RISK_GATE("shadow"),
    ],
  },
  {
    preset: "agentless-v3-thin-strict-gated-llm",
    base: THIN_STRICT_BASE.knobs,
    modules: [
      SELECT_N(2),
      REGRESSION("discovered"),
      RISK_GATE,
      SELECT_REPRO_OFF,
      LLM_RISK_GATE("on"),
    ],
  },
  {
    preset: "agentless-v3-thin-strict-closure-select",
    base: THIN_STRICT_BASE.knobs,
    modules: [...SELECT_MODULES, CLOSURE_GROUNDING],
  },
  {
    preset: "agentless-v3-thin-strict-closure-select-clean-witness-only",
    base: THIN_STRICT_BASE.knobs,
    modules: [
      SELECT_N(5),
      REGRESSION("discovered"),
      SELECT_REPRO_OFF,
      CLOSURE_GROUNDING,
      CLEAN_SELECTOR,
    ],
  },
  // ── select-regression family over the v3-thin base ──
  { preset: "agentless-v3-select-regression", base: THIN_BASE.knobs, modules: SELECT_MODULES },
  {
    preset: "agentless-v3-select-regression-doubt",
    base: THIN_BASE.knobs,
    modules: [...SELECT_MODULES, REPRO_DOUBT(5)],
  },
]

/** The composed knob map for a declared preset (the value its frozen literal is
 *  pinned to). Throws if the preset is not a known composite. */
export const composedKnobsForPreset = (preset: string): Readonly<Record<string, string>> => {
  const entry = PRESET_COMPOSITES.find((c) => c.preset === preset)
  if (entry === undefined) throw new Error(`no composite declared for preset "${preset}"`)
  return composePresetKnobs(entry.base, entry.modules)
}
