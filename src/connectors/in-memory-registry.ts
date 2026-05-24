/**
 * In-memory connector registry — testing impl (ADR-0160 Phase B).
 *
 * Mirrors `ConnectorRegistryPort` semantics with a frozen seed. `refresh()`
 * always returns `"cached-fresh"` (no upstream to refresh against). `list()`
 * returns the seed verbatim — order preserved.
 */

import type { Connector, ConnectorRegistryPort, RefreshOutcome } from "./types"

/**
 * Build an in-memory registry from a fixed connector list. The seed is copied
 * into a private frozen array so external mutation cannot leak in.
 */
export const createInMemoryConnectorRegistry = (
  seed: ReadonlyArray<Connector>,
): ConnectorRegistryPort => {
  const snapshot: ReadonlyArray<Connector> = Object.freeze([...seed])
  const byId = new Map<string, Connector>(snapshot.map((c) => [c.id, c]))

  return {
    list: async (): Promise<ReadonlyArray<Connector>> => snapshot,
    get: async (id: string): Promise<Connector | undefined> => byId.get(id),
    refresh: async (): Promise<RefreshOutcome> => "cached-fresh",
  }
}
