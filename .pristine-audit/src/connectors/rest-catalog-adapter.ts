/**
 * REST-registry → MCP-connector-CATALOG adapter (ADR-0160 wire-up; closes the
 * "built-not-wired" gap REPORT-jun26 §2/§4.4 flagged).
 *
 * The `ConnectorRegistryPort` (`rest-registry.ts`, `createRestConnectorRegistry`)
 * is the server-driven catalog Claude's `search_mcp_registry` mirrors — but it
 * speaks {@link Connector} (id/displayName/host/auth/oauthIssuer), an
 * AVAILABILITY/AUTH descriptor, NOT the installable launch template
 * {@link McpConnectorEntry} (id/name/transport/command/url) that
 * `buildMcpConnectorDiscoveryPort` / `toMcpServerConfig` consume. The two are
 * deliberately separate slices; this is the missing seam between them.
 *
 * SHAPE BRIDGE (the only honest mapping the registry shape supports):
 *   - A server-published connector with no `command` is, by construction, an
 *     HTTP (Streamable-HTTP/SSE) MCP endpoint — so every entry is `transport:
 *     "http"`. The endpoint `url` is derived from the connector `host` as its
 *     https origin (the standard MCP pattern: the resource server's origin; the
 *     same origin `rest-registry`/availability probing and RFC-8414 OAuth
 *     discovery key on). A `host` that is already an absolute http(s) URL is used
 *     verbatim; a bare host becomes `https://<host>`.
 *   - `requiresOAuth` iff `auth === "oauth"` (so the installed server opts into
 *     the H18 per-server OAuth path).
 *   - `name`/`description` from `displayName` (description falls back to the
 *     display name when the registry omits a richer blurb — the descriptor has
 *     no separate description field).
 *
 * SYNC SNAPSHOT: `McpConnectorCatalogPort.list()`/`get()` are SYNC, while the
 * REST registry is ASYNC (network + 24h cache). So the host fetches ONE snapshot
 * (`registry.list()`) and hands the frozen `Connector[]` here; this adapter is a
 * pure, deterministic view over that snapshot (no I/O). The host re-snapshots on
 * its own cadence (the registry's own TTL governs staleness). `fetchCatalog`
 * does the async fetch + map in one place so callers get a ready snapshot.
 *
 * NO-THROW / fence-clean: imports only `./mcp-connector-catalog` + `./types`.
 * A malformed `host` that cannot form a URL is DROPPED (not installable), never
 * a throw — an un-URL-able registry row must not poison the whole catalog.
 */

import type { McpConnectorCatalogPort, McpConnectorEntry } from "./mcp-connector-catalog"
import { createMcpConnectorCatalog } from "./mcp-connector-catalog"
import type { Connector, ConnectorRegistryPort } from "./types"

/** Derive the http MCP endpoint URL from a connector `host`. An absolute
 *  http(s) URL is honored verbatim; a bare host is promoted to its https origin.
 *  Returns `undefined` when no valid http(s) URL can be formed (caller drops the
 *  row — an un-URL-able entry is not installable). */
const endpointUrl = (host: string): string | undefined => {
  const trimmed = host.trim()
  if (trimmed === "") return undefined
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Map ONE registry {@link Connector} to an installable http {@link McpConnectorEntry}.
 * Returns `undefined` when the `host` cannot form an http(s) URL (the row is not
 * installable and is dropped by {@link connectorsToEntries}).
 */
export const connectorToMcpEntry = (c: Connector): McpConnectorEntry | undefined => {
  const url = endpointUrl(c.host)
  if (url === undefined) return undefined
  // The registry descriptor has no separate `description`; fall back to the id
  // when `displayName` is blank so the catalog row is never empty-labelled.
  const label = c.displayName.trim() === "" ? c.id : c.displayName
  return {
    id: c.id,
    name: label,
    description: label,
    transport: "http",
    url,
    ...(c.auth === "oauth" ? { requiresOAuth: true } : {}),
  }
}

/** Map a `Connector[]` snapshot to installable `McpConnectorEntry[]`, dropping
 *  rows whose `host` cannot form an http(s) URL. Deterministic order = input
 *  order (the catalog re-sorts by id on `list()`). */
export const connectorsToEntries = (
  connectors: ReadonlyArray<Connector>,
): readonly McpConnectorEntry[] => {
  const out: McpConnectorEntry[] = []
  for (const c of connectors) {
    const entry = connectorToMcpEntry(c)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/** Build a SYNC {@link McpConnectorCatalogPort} over a pre-fetched
 *  `Connector[]` snapshot. Pure — no I/O. The host obtains the snapshot via
 *  {@link ConnectorRegistryPort.list} (async) and passes it here. */
export const restRegistrySnapshotToCatalog = (
  connectors: ReadonlyArray<Connector>,
): McpConnectorCatalogPort => createMcpConnectorCatalog(connectorsToEntries(connectors))

/**
 * Async one-shot: fetch the registry's current catalog and adapt it to a SYNC
 * {@link McpConnectorCatalogPort} the discovery port can consume. This is the
 * seam the host wires when a remote registry URL is configured — `list()` runs
 * the registry's cache/refresh logic, then the result is frozen into a sync
 * snapshot. The registry's own 24h TTL governs staleness; the host re-calls to
 * refresh.
 *
 * `list()` may THROW `ConnectorOutageError` (registry unreachable AND no cache) —
 * that propagates so the host can branch (fall back to BUNDLED / surface the
 * outage) rather than silently treat an outage as an empty catalog.
 */
export const fetchCatalogFromRegistry = async (
  registry: ConnectorRegistryPort,
): Promise<McpConnectorCatalogPort> => {
  const connectors = await registry.list()
  return restRegistrySnapshotToCatalog(connectors)
}
