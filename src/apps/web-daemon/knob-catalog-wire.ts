/**
 * `apps/web-daemon/knob-catalog-wire.ts` — web composition adapter (ADR-0503 P3).
 *
 * The web surface composes the knob catalog from the registries it can reach by
 * layering: `@/config/knob-inventory` (daemon/agent) + `@/runner/knobs`. It does
 * NOT include `apps/cli/cli-knobs.ts` — those are terminal-render-only and (a)
 * irrelevant to a web client, (b) un-importable (apps/cli is a peer surface, not
 * a library). Secrets are already absent from the inventory by construction
 * (ADR-0503), so the served catalog never leaks credentials.
 */

import {
  type CatalogSources,
  catalogByGroup,
  mergeKnobCatalog,
  resolveCatalogValues,
  type UnifiedKnob,
} from "@/config/knob-catalog"
import { allInventoryKnobs } from "@/config/knob-inventory"
import { allKnobs } from "@/runner/knobs"
import { allRuntimeConfigKnobs } from "@/shared/runtime-config-knobs"
// Side-effect: populate the @/runner/knobs registry (def modules self-register).
import "@/runner/knobs/knobs"

/** Build the web-facing unified catalog (inventory + runner; NO cli-render knobs). */
export const buildWebKnobCatalog = (): ReadonlyMap<string, UnifiedKnob> => {
  const sources: CatalogSources = {
    cli: [], // intentional — CLI render knobs do not apply to the web surface
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

export { catalogByGroup, resolveCatalogValues }
export type { UnifiedKnob }
