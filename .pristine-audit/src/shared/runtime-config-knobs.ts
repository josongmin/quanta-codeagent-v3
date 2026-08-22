/**
 * `@/shared/runtime-config-knobs.ts` — DECLARATION registry for the typed
 * `runtime-config` knobs (ADR-0503 P3, catalog completeness).
 *
 * The ~145 knobs read by `runtime-config.ts`'s `loadFromEnv` are consumed as
 * `runtimeConfig().<field>` (typed struct), so they never appear as a quoted
 * `QUANTA_X` literal in slices — which means the unified catalog (cli + inventory
 * + runner) was MISSING them. This registry declares them (envKey/kind/default/
 * describe/group) so the catalog (`/knobs all`, `--help`, web `/api/knobs`)
 * becomes the TRUE single SSOT over every quanta knob.
 *
 * DECLARATION-ONLY + PURE DATA (no imports, no env reads). Lives in @/shared
 * (the layer runtime-config lives in) so both surface wires (apps/cli, apps/web)
 * can import it downward. `home: "runtime-config"` for all (these ARE the typed
 * runtime-config fields). Secrets are credential VALUES, absent by design — the
 * credential-HELPER command knobs (api-key-helper, *-auth-refresh) are config,
 * not secrets, so they stay.
 */

import { KNOBS_A } from "./runtime-config-knobs/knobs-a"
import { KNOBS_B } from "./runtime-config-knobs/knobs-b"
import { KNOBS_C } from "./runtime-config-knobs/knobs-c"
import type { RuntimeConfigKnob } from "./runtime-config-knobs/types"

// Contract types + per-category knob entries moved to ./runtime-config-knobs/
// (god-module split). Re-export the contract so importers of
// @/shared/runtime-config-knobs stay byte-compatible.
export type { RcKind, RuntimeConfigKnob } from "./runtime-config-knobs/types"

/** Full typed runtime-config knob registry — the category sub-registries
 *  concatenated in declaration order (identical to the prior single array). */
export const RUNTIME_CONFIG_KNOBS: readonly RuntimeConfigKnob[] = [
  ...KNOBS_A,
  ...KNOBS_B,
  ...KNOBS_C,
]

export const allRuntimeConfigKnobs = (): readonly RuntimeConfigKnob[] => RUNTIME_CONFIG_KNOBS
