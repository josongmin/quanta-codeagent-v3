/**
 * ADR-0336 — App resolver impl (closes ADR-0330's
 * `resolveApp → null` negative invariant).
 *
 * Builds the `resolveApp` method of an ADR-0325 `MentionResolverPort`.
 * Wired over the `AppCatalogPort` from `@/agent/app-catalog`. The
 * resolved bodyText embeds the closed-enum surface so the model has
 * a concrete reference for where the app actually runs (per quanta
 * `surface-model.md`):
 *
 *   bodyText = `surface: <surface>` + (description ? ` — <description>` : "")
 *
 * Example: `@@browser` resolved against the default catalog yields:
 *
 *   bodyText: "surface: cli-browser — the CLI-embedded browser surface"
 *
 * NO-THROW: every call wrapped in try/catch.
 */

import type { AppCatalogPort, AppDescriptor } from "@/agent/app-catalog"
import type { MentionResolverPort } from "@/agent/mention-injection"

const safeLookup = (catalog: AppCatalogPort | undefined, target: string): AppDescriptor | null => {
  if (catalog === undefined) return null
  try {
    return catalog.lookup(target)
  } catch {
    return null
  }
}

/** Project the descriptor into the mention bodyText. Always prefixed
 *  with `surface: <surface>` so the model sees the surface binding
 *  on every resolved app mention. */
const bodyTextFrom = (descriptor: AppDescriptor): string => {
  const base = `surface: ${descriptor.surface}`
  if (typeof descriptor.description !== "string") return base
  if (descriptor.description.length === 0) return base
  return `${base} — ${descriptor.description}`
}

/**
 * Build the `resolveApp` method of a {@link MentionResolverPort}.
 *
 * @param catalog — closed-port app catalog. Omit ⇒ every app mention
 *                  resolves to `null` (skipped).
 */
export const createAppResolver = (catalog?: AppCatalogPort): MentionResolverPort["resolveApp"] => {
  return (target: string) => {
    if (typeof target !== "string" || target.length === 0) return null
    const descriptor = safeLookup(catalog, target)
    if (descriptor === null) return null
    return { bodyText: bodyTextFrom(descriptor) }
  }
}
