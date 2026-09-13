/**
 * `apps/cli/knob-catalog-wire.ts` — composition adapter (ADR-0503 P3).
 *
 * The CLI surface is the top layer, so it (and only it) may import all three
 * knob registries and hand them to the PURE `mergeKnobCatalog` (@/config). This
 * yields the single unified catalog that powers `/knobs` (list/find/show) and
 * the `--help` env section — and gives `cli-knobs.ts` + `knob-inventory.ts` a
 * real consumer (they are no longer declaration-only dead data).
 */

import {
  type CatalogSources,
  catalogByGroup,
  catalogList,
  knobEnumValues as configKnobEnumValues,
  displaySafeValue,
  mergeKnobCatalog,
  type ResolvedKnobValue,
  resolveCatalogValues,
  searchCatalog,
  type UnifiedKnob,
} from "@/config/knob-catalog"
import { allInventoryKnobs } from "@/config/knob-inventory"
import { ALL_PERMISSION_MODES } from "@/permission"
import { allKnobs } from "@/runner/knobs"
import { allRuntimeConfigKnobs } from "@/shared/runtime-config-knobs"
// Side-effect: populate the @/runner/knobs registry (its def modules self-register
// via `registerKnob(...)` on import). Without this, `allKnobs()` is empty unless
// the CLI bootstrap already ran. Importing the bundle makes the catalog complete
// regardless of call order.
import "@/runner/knobs/knobs"
import { allCliKnobs } from "./cli-knobs"

/** Read the three registries and merge into the canonical unified catalog. */
export const buildKnobCatalog = (): ReadonlyMap<string, UnifiedKnob> => {
  const sources: CatalogSources = {
    cli: allCliKnobs().map((k) => ({
      envKey: k.envKey,
      kind: k.kind,
      default: k.default,
      describe: k.describe,
      group: k.group,
      readSite: k.readSite,
    })),
    inventory: allInventoryKnobs().map((k) => ({
      envKey: k.envKey,
      kind: k.kind,
      default: k.default,
      describe: k.describe,
      group: k.group,
      home: k.home,
      readSite: k.readSite,
    })),
    runtimeConfig: allRuntimeConfigKnobs().map((k) => ({
      envKey: k.envKey,
      kind: k.kind,
      default: k.default,
      describe: k.describe,
      group: k.group,
    })),
    runner: [...allKnobs().values()].map((k) => ({
      envKey: k.envKey,
      describe: k.describe,
      category: k.category,
      ...(k.default !== undefined ? { default: k.default } : {}),
      ...(k.hotToggleable !== undefined ? { hotToggleable: k.hotToggleable } : {}),
    })),
  }
  return mergeKnobCatalog(sources)
}

/**
 * Closed enum sets whose union lives ABOVE `@/config`. `QUANTA_PERMISSION` is declared
 * `kind: "enum"` and its describe names the modes; without a set, `/knobs set`'s
 * membership gate saw `undefined` and let any spelling through to the next gate. The
 * set was first added inside `@/config/knob-catalog.ts` by importing `@/permission`,
 * which that slice's deny-list forbids — the file is pure by contract. It lives here,
 * where the surface already composes the registries, derived from the closed union.
 */
const SURFACE_KNOB_ENUM_VALUES: ReadonlyMap<string, readonly string[]> = new Map([
  ["QUANTA_PERMISSION", [...ALL_PERMISSION_MODES]],
])

/** Closed valid set for an enum knob: the surface-owned sets, then `@/config`'s. */
export const knobEnumValues = (envKey: string): readonly string[] | undefined =>
  SURFACE_KNOB_ENUM_VALUES.get(envKey) ?? configKnobEnumValues(envKey)

export type { ResolvedKnobValue, UnifiedKnob }
/** Re-exports so the CLI command modules import one place. */
export { catalogByGroup, catalogList, displaySafeValue, resolveCatalogValues, searchCatalog }
