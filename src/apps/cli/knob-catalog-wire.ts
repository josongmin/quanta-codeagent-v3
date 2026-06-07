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
  displaySafeValue,
  knobEnumValues,
  mergeKnobCatalog,
  resolveCatalogValues,
  type ResolvedKnobValue,
  searchCatalog,
  type UnifiedKnob,
} from "@/config/knob-catalog"
import { allInventoryKnobs } from "@/config/knob-inventory"
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

/** Re-exports so the CLI command modules import one place. */
export {
  catalogByGroup,
  catalogList,
  displaySafeValue,
  knobEnumValues,
  resolveCatalogValues,
  searchCatalog,
}
export type { ResolvedKnobValue, UnifiedKnob }
