/**
 * Pillar C — preset = pipeline spec, ONE source of truth.
 *
 * `resolvePresetSpec` GENERATES the flat resolved knob map from a {@link PresetSpec}:
 * start from the knob-id → default raw baseline, then apply the preset's `params`
 * overrides (last-wins). This is the function that lets a preset be stored ONCE (as
 * a `PresetSpec` of ordered step ids + param overrides) instead of TWICE (the frozen
 * literal in `runner/knobs/presets.ts` AND the composite in `posture/compose-preset.ts`,
 * kept in sync by a byte-identical golden oracle). Once parity is proven (see
 * `tests/unit/kernel/preset-spec-parity.test.ts`), the literal can be deleted and the
 * spec becomes the single source — the generated map equals the old literal byte-for-byte.
 *
 * Pure + deterministic: no I/O, no env reads, no mutation of inputs. Given the same
 * `(spec, defaults)` it always returns the same map.
 */

import type { PresetSpec } from "@/config/knob-schema/contracts"

/**
 * Resolve a {@link PresetSpec} to the flat knob map the pipeline consumes.
 *
 * @param spec     the preset's pipeline spec (`params` = knob-id → raw override).
 * @param defaults knob-id → default raw value baseline. Pass `{}` when the preset's
 *                 `params` are fully explicit (the current frozen literals are — every
 *                 knob the preset cares about is named, so no defaults are needed for
 *                 byte-parity with `KNOB_PRESETS[spec.id]`).
 * @returns        a frozen, flat `knob-id → raw` map = `defaults` overlaid with
 *                 `spec.params` (overrides win, last-wins on duplicate keys).
 */
export function resolvePresetSpec(
  spec: PresetSpec,
  defaults: Record<string, string>,
): Readonly<Record<string, string>> {
  // Start from the defaults baseline, then overlay the preset's explicit overrides.
  // Object spread is last-wins, so `spec.params` deterministically beats `defaults`.
  return Object.freeze({ ...defaults, ...spec.params })
}
