/**
 * ADR-0336 — In-memory {@link AppCatalogPort} adapter.
 *
 * Pure (no I/O, no clock read). Snapshots the input list at
 * construction time so post-construction caller mutations do not
 * leak. Duplicate ids: last-write-wins (mirrors the in-memory
 * plugin registry policy).
 *
 * NO-THROW invariant: `lookup` / `list` never throw. `lookup` for
 * empty / whitespace-only id returns `null`.
 */

import { DEFAULT_APP_CATALOG } from "./default-catalog"
import type { AppCatalogPort, AppDescriptor } from "./types"

/**
 * Build an in-memory catalog over a static descriptor list. Duplicate
 * ids: last-write-wins. Empty list ⇒ a catalog where every lookup
 * returns `null` and `list()` returns `[]`.
 */
export const createInMemoryAppCatalog = (descriptors: readonly AppDescriptor[]): AppCatalogPort => {
  const byId = new Map<string, AppDescriptor>()
  for (const d of descriptors) {
    if (d === null || typeof d !== "object") continue
    if (typeof d.id !== "string" || d.id.length === 0) continue
    byId.set(d.id, d)
  }
  const snapshot: AppDescriptor[] = []
  for (const d of byId.values()) snapshot.push(d)

  return {
    lookup(id: string): AppDescriptor | null {
      if (typeof id !== "string") return null
      const trimmed = id.trim()
      if (trimmed.length === 0) return null
      return byId.get(trimmed) ?? null
    },
    list(): readonly AppDescriptor[] {
      return snapshot
    },
  }
}

/**
 * The default 3-surface catalog wrapped as an {@link AppCatalogPort}.
 * The composition root SHOULD use this unless a feature ADR overrides
 * the catalog (e.g. a per-workspace catalog file, or a plugin-declared
 * extension — both future ADRs).
 */
export const defaultAppCatalog: AppCatalogPort = createInMemoryAppCatalog(DEFAULT_APP_CATALOG)
