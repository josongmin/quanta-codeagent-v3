/**
 * ADR-0336 — Plugin resolver impl (closes ADR-0330's
 * `resolvePlugin → null` negative invariant).
 *
 * Builds the `resolvePlugin` method of an ADR-0325
 * `MentionResolverPort`. Wired over the `PluginRegistryPort` from
 * `@/agent/plugin-discovery`. Progressive-disclosure parity with the
 * skill resolver:
 *
 *   - Hit  ⇒ bodyText = first line of `manifest.description` if
 *            present, else a concise fallback summary (`<name>
 *            (capabilities: …)`) derived from the manifest.
 *   - Miss ⇒ `null` (skip — DO NOT emit a fragment for unknown
 *            targets, identical to ADR-0330's skill resolver
 *            policy).
 *
 * NO-THROW: every call is wrapped in a try/catch and degrades to
 * `null` on any registry exception. Belt-and-suspenders since the
 * resolver wrapper at ADR-0325 also catches.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import type { PluginManifest, PluginRegistryPort } from "@/agent/plugin-discovery"

/** Project a description to its first line. Mirrors the skill
 *  resolver's `firstLineOf` (CRLF-tolerant). Empty / non-string ⇒
 *  empty string. */
const firstLineOf = (description: string | undefined): string => {
  if (typeof description !== "string" || description.length === 0) return ""
  const nl = description.indexOf("\n")
  const slice = nl === -1 ? description : description.slice(0, nl)
  return slice.endsWith("\r") ? slice.slice(0, -1) : slice
}

/** Build a fallback bodyText from the manifest itself when no
 *  description is provided. Format: `<name> (capabilities: <list>)`.
 *  An empty capability set ⇒ `<name>`. */
const fallbackBody = (manifest: PluginManifest): string => {
  const caps =
    manifest.capabilities.length === 0 ? "" : ` (capabilities: ${manifest.capabilities.join(", ")})`
  return `${manifest.name}${caps}`
}

/**
 * Safe wrapper around the registry's `lookup`. NO-THROW.
 */
const safeLookup = (
  registry: PluginRegistryPort | undefined,
  target: string,
): PluginManifest | null => {
  if (registry === undefined) return null
  try {
    return registry.lookup(target)
  } catch {
    return null
  }
}

/**
 * Build the `resolvePlugin` method of a {@link MentionResolverPort}.
 *
 * @param registry — closed-port plugin registry. Omit ⇒ every plugin
 *                   mention resolves to `null` (skipped).
 * @returns        — a function suitable for direct assignment to
 *                   `MentionResolverPort.resolvePlugin`.
 */
export const createPluginResolver = (
  registry?: PluginRegistryPort,
): MentionResolverPort["resolvePlugin"] => {
  return async (target: string) => {
    if (typeof target !== "string" || target.length === 0) return null
    const manifest = safeLookup(registry, target)
    if (manifest === null) return null
    const fromDesc = firstLineOf(manifest.description)
    const bodyText = fromDesc.length === 0 ? fallbackBody(manifest) : fromDesc
    return { bodyText }
  }
}
