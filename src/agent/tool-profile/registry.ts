/**
 * Tool profile registry (ADR-0213).
 *
 * Thin lookup over {@link PROFILE_PRESETS} that exposes a port-shaped
 * interface (`getPreset` + `hasPreset`) for tests + the resolver. Pure;
 * no IO, no state.
 */

import { ALL_TOOL_PROFILE_NAMES, type ToolProfileName } from "./port"
import { PROFILE_PRESETS, type ToolProfilePresetSpec } from "./presets"

/** A registry surface — what the resolver depends on. Production wire is
 *  {@link defaultToolProfileRegistry}; tests can inject hand-rolled
 *  registries to add fixture presets without mutating the frozen
 *  module-level table. */
export interface ToolProfileRegistry {
  getPreset(name: ToolProfileName): ToolProfilePresetSpec | undefined
  hasPreset(name: string): name is ToolProfileName
  names(): ReadonlyArray<ToolProfileName>
}

/** Construct the default registry — a thin reader over the frozen
 *  {@link PROFILE_PRESETS} table. Returns a fresh object per call so
 *  callers can stub one method without leaking into the next caller. */
export const defaultToolProfileRegistry = (): ToolProfileRegistry => {
  return {
    getPreset(name: ToolProfileName): ToolProfilePresetSpec | undefined {
      return PROFILE_PRESETS[name]
    },
    hasPreset(name: string): name is ToolProfileName {
      return (ALL_TOOL_PROFILE_NAMES as ReadonlyArray<string>).includes(name)
    },
    names(): ReadonlyArray<ToolProfileName> {
      return ALL_TOOL_PROFILE_NAMES
    },
  }
}
