/**
 * N2 — MCP connector discovery / catalog (backlog §7).
 *
 * A discoverable catalog of MCP SERVERS (vs hand-editing `.mcp.json`). Pairs with
 * H18 (OAuth = auth; this = discovery/catalog). Reference: Codex
 * `imported-connector-apps` / `connector-logo`.
 *
 * Two halves:
 *   - the PURE catalog model + `toMcpServerConfig` transform (catalog entry →
 *     the `.mcp.json` server-config shape quanta consumes) — no I/O, deterministic;
 *   - an injected `McpConnectorCatalogPort` (the SOURCE — a bundled list, a remote
 *     catalog, or the REST connector registry — the host's choice; default is the
 *     pure in-memory `createMcpConnectorCatalog(entries)`).
 *
 * Slice posture (RFC §3.1): PURE leaf — imports only `@/shared` (byteCompare).
 * The transform's OUTPUT is a STRUCTURAL MIRROR of `@/mcp`'s `McpServerConfig`
 * ({@link McpServerConfigShape}) so `@/connectors` need not import `@/mcp` (the
 * host, which owns both, feeds the result to the real `.mcp.json` writer).
 * NO-THROW. DEFAULT-OFF: no source wired ⇒ an empty catalog ⇒ discovery returns
 * nothing (byte-identical — nothing to install).
 */

import { byteCompare } from "@/shared"

/** How a catalogued MCP server is carried. */
export type McpConnectorTransport = "stdio" | "http"

/** One discoverable MCP server in the catalog. */
export interface McpConnectorEntry {
  /** Stable catalog id (the install key). */
  readonly id: string
  /** Human display name. */
  readonly name: string
  readonly description: string
  readonly transport: McpConnectorTransport
  /** stdio carrier: argv to spawn. Required when `transport === "stdio"`. */
  readonly command?: readonly string[]
  /** http carrier: endpoint URL. Required when `transport === "http"`. */
  readonly url?: string
  /** Default env to merge (stdio). */
  readonly env?: Readonly<Record<string, string>>
  /** When true, the installed server opts into H18 per-server OAuth (http only). */
  readonly requiresOAuth?: boolean
}

/**
 * Structural MIRROR of `@/mcp`'s `McpServerConfig` — the `.mcp.json` install
 * shape. Kept local so `@/connectors` stays fence-clean; the host passes this to
 * the real MCP config writer (where the type unifies structurally).
 */
export interface McpServerConfigShape {
  readonly name: string
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly oauth?: boolean
}

/** The injected catalog SOURCE (bundled / remote / registry-backed). */
export interface McpConnectorCatalogPort {
  list(): readonly McpConnectorEntry[]
  get(id: string): McpConnectorEntry | undefined
}

export type McpInstallError = "unknown-id" | "missing-command" | "missing-url"

export type McpInstallResult =
  | { readonly ok: true; readonly config: McpServerConfigShape }
  | { readonly ok: false; readonly error: McpInstallError }

/**
 * PURE transform: a catalog entry → the `.mcp.json` server config. NO-THROW
 * (typed error): a `stdio` entry MUST carry a non-empty `command`; an `http`
 * entry MUST carry a `url`. `oauth` is set only for an http entry that requires
 * it (stdio has no auth carrier). `name` = the catalog id (the stable handle the
 * `.mcp.json` keys on).
 */
export const toMcpServerConfig = (entry: McpConnectorEntry): McpInstallResult => {
  if (entry.transport === "stdio") {
    if (entry.command === undefined || entry.command.length === 0) {
      return { ok: false, error: "missing-command" }
    }
    return {
      ok: true,
      config: {
        name: entry.id,
        command: entry.command,
        ...(entry.env !== undefined ? { env: entry.env } : {}),
      },
    }
  }
  // http
  if (entry.url === undefined || entry.url.length === 0) {
    return { ok: false, error: "missing-url" }
  }
  return {
    ok: true,
    config: {
      name: entry.id,
      command: [],
      url: entry.url,
      ...(entry.requiresOAuth === true ? { oauth: true } : {}),
    },
  }
}

/**
 * Bundled default catalog — a small curated set of well-known reference MCP
 * servers (the `@modelcontextprotocol/server-*` family + a representative http
 * connector). This is the DEFAULT source `createMcpConnectorCatalog` is seeded
 * with when the host opts in (`QUANTA_MCP_CONNECTORS=1`) and supplies no override
 * list. Pure DATA — the entries are launch templates; whether a given package is
 * installed on the box is resolved at spawn time by the MCP launcher, not here.
 * The host may replace this with a remote catalog / REST registry adapter.
 */
export const BUNDLED_MCP_CONNECTORS: readonly McpConnectorEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read/write files under an allowed root (reference server).",
    transport: "stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repos, issues, and PRs via the GitHub API (needs GITHUB_TOKEN).",
    transport: "stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
  },
  {
    id: "memory",
    name: "Knowledge-graph memory",
    description: "Persistent knowledge-graph memory across sessions.",
    transport: "stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    description: "Structured step-by-step reasoning scratchpad.",
    transport: "stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
] as const

/** In-memory catalog over a fixed entry list — the default `McpConnectorCatalogPort`.
 *  `list()` is a deterministic (by id, byteCompare) immutable snapshot. The host
 *  supplies the entries (bundled file / remote fetch / REST registry adapter). */
export const createMcpConnectorCatalog = (
  entries: readonly McpConnectorEntry[],
): McpConnectorCatalogPort => {
  const byId = new Map(entries.map((e) => [e.id, e] as const))
  return {
    list() {
      return [...byId.values()].sort((a, b) => byteCompare(a.id, b.id))
    },
    get(id) {
      return byId.get(id)
    },
  }
}
