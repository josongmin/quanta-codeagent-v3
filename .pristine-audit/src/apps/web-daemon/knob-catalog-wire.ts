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
  displaySafeValue,
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

/**
 * Web-safe value for a knob over `/api/knobs`. A CUSTOM free-form STRING value
 * (source env/session) may hold a filesystem path, credential-helper command
 * line, or policy JSON — never echo it over the network. Bounded bool/int/float/
 * enum values are safe; registry DEFAULTS are public (in source), so only a
 * non-default string value is redacted. (ADR-0503 P3, security re-audit jun-7.)
 */
export const webSafeKnobValue = (
  kind: UnifiedKnob["kind"],
  resolved: { readonly raw: string | undefined; readonly source: string } | undefined,
): string | undefined => displaySafeValue(kind, resolved?.raw, resolved?.source)

export type { UnifiedKnob }
export { catalogByGroup, resolveCatalogValues }
