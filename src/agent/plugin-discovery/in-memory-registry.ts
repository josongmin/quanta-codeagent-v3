/**
 * ADR-0336 — In-memory {@link PluginRegistryPort} adapter.
 *
 * Pure (no I/O, no clock read). Used by tests, headless surfaces, and
 * the composition root when fs discovery is bypassed (e.g. a static
 * plugin list baked into a release).
 *
 * NO-THROW invariant: `lookup` / `list` never throw. `lookup` for an
 * empty / whitespace-only id returns `null` (no call-through).
 *
 * Lookup is by id, case-sensitive (Codex parity — plugin ids are
 * ASCII kebab-case by convention, exact match).
 */

import type { PluginManifest, PluginRegistryPort } from "./types"

/**
 * Build an in-memory registry over a static manifest list. Duplicate
 * ids: last-write-wins (the trailing entry in `manifests` shadows
 * earlier ones with the same id). Empty list ⇒ a registry where
 * every lookup returns `null` and `list()` returns `[]`.
 */
export const createInMemoryPluginRegistry = (
  manifests: readonly PluginManifest[],
): PluginRegistryPort => {
  // Snapshot at construction time so post-construction mutations to
  // the caller's array do not leak into the registry.
  const snapshot: PluginManifest[] = []
  const byId = new Map<string, PluginManifest>()
  for (const m of manifests) {
    if (m === null || typeof m !== "object") continue
    if (typeof m.id !== "string" || m.id.length === 0) continue
    byId.set(m.id, m)
  }
  for (const m of byId.values()) snapshot.push(m)

  return {
    lookup(id: string): PluginManifest | null {
      if (typeof id !== "string") return null
      const trimmed = id.trim()
      if (trimmed.length === 0) return null
      return byId.get(trimmed) ?? null
    },
    list(): readonly PluginManifest[] {
      return snapshot
    },
  }
}

/**
 * The always-empty registry. Default for headless / test contexts
 * that don't want to fabricate a fake. Every `lookup` returns `null`.
 */
export const emptyPluginRegistry: PluginRegistryPort = createInMemoryPluginRegistry([])
