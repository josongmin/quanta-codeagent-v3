import type {
  ResourcesHandleResult as HandleResult,
  PromptEntry,
  PromptResult,
  ResourceBlock,
  ResourceEntry,
  ResourcesHandle,
  ResourceTemplateEntry,
} from "@/tool"

/**
 * MCP RESOURCES/PROMPTS AGGREGATE (N3) — many live MCP clients ⇒ ONE handle.
 *
 * ONE responsibility: fan the six `resources/*` + `prompts/*` operations out
 * across every connected server and fold the answers back into a single
 * duck-typed `ResourcesHandle` (the host port the five N3 tools consume), with
 * the fan-out policy that decides WHICH result wins: lists CONCAT (a
 * capability-less or failing server is skipped, never shadows the others) while
 * single-item reads ROUTE (first hit wins; a real failure is only surfaced when
 * nobody hit). NO-THROW end to end.
 *
 * The structural mirrors declared here (`McpResourcesClient` /
 * `ResourcesCapableClient`) are what let a concrete `McpClient` AND an
 * `McpReconnectSupervisor` join the aggregate without a per-method adapter,
 * honoring the slice fence that forbids `@/tool` importing `@/mcp` — this module
 * imports only `@/tool` types and asserts the identity at compile time.
 *
 * Split out of `mcp-bridge.ts` (god-module ratchet) — pure move; `mcp-bridge.ts`
 * re-exports these names so no consumer import path changes.
 */

// ── N3 — MCP resources/prompts aggregate ───────────────────────────────────

/** The subset of a live `McpClient` the resources aggregate consumes. The four
 *  methods' result shapes (`McpResult<McpResource[]>` …) are STRING-IDENTICAL
 *  mirrors of the `@/tool` `HandleResult<ResourceEntry[]>` … types, so the
 *  concrete `McpClient` satisfies this WITHOUT a per-method adapter — the slice
 *  fence (which forbids `@/tool` importing `@/mcp`) is honored because THIS
 *  bridge layer imports both and is where the structural identity is asserted at
 *  compile time. Any drift in either declaration is a TYPE error at
 *  {@link aggregateResourcesHandle}. */
export interface McpResourcesClient {
  listResources(): Promise<HandleResult<ResourceEntry[]>>
  listResourceTemplates(): Promise<HandleResult<ResourceTemplateEntry[]>>
  readResource(uri: string): Promise<HandleResult<ResourceBlock[]>>
  /** B4 — direct children of a directory-shaped resource uri. STRING-IDENTICAL
   *  to the source `McpClient.readResourceDir` + the `@/tool` `ResourcesHandle`
   *  member; drift is a TYPE error at {@link aggregateResourcesHandle}. */
  readResourceDir(uri: string): Promise<HandleResult<ResourceEntry[]>>
  listPrompts(): Promise<HandleResult<PromptEntry[]>>
  getPrompt(name: string, args?: Record<string, unknown>): Promise<HandleResult<PromptResult>>
}

/** A failure is `unsupported` IFF the server never advertised the capability —
 *  the aggregate treats such a client as "absent" for the operation (skipped in
 *  lists, transparent in routing) rather than letting one capability-less server
 *  shadow the others. */
const isUnsupported = (r: HandleResult<unknown>): boolean =>
  r.ok === false && r.reason === "unsupported"

/** Aggregate one-or-more live MCP clients behind a SINGLE duck-typed
 *  `ResourcesHandle` (the five N3 tools' host port). NO-THROW end to end (every
 *  member returns a typed `HandleResult`, exactly as each underlying `McpClient`
 *  method does).
 *
 *  Semantics:
 *   - `listResources` / `listPrompts` — CONCAT across all clients; a client whose
 *     server didn't advertise the capability (`unsupported`) is SKIPPED, and a
 *     client that errors (transport / malformed) is skipped too (best-effort, the
 *     other servers' entries still surface). Always `ok:true` (possibly empty).
 *   - `readResource(uri)` / `getPrompt(name)` — ROUTE: try clients IN ORDER,
 *     return the FIRST result that is not `unsupported` (an `ok:true` hit, or the
 *     first real failure from a capable server). When every client is
 *     `unsupported` (or the client list is empty), return a typed `unsupported`
 *     failure — never a throw.
 *
 *  Empty client list ⇒ lists are `ok:true` empty, reads are `unsupported`. The
 *  surface only wires this handle when at least one client supports the surface
 *  (see {@link resourcesHandleFor}), so the empty-handle path is defensive. */
export const aggregateResourcesHandle = (clients: McpResourcesClient[]): ResourcesHandle => {
  const concat = async <T>(
    call: (c: McpResourcesClient) => Promise<HandleResult<T[]>>,
  ): Promise<HandleResult<T[]>> => {
    const acc: T[] = []
    for (const c of clients) {
      const r = await call(c)
      if (r.ok) acc.push(...r.value)
      // unsupported + any transport/malformed failure ⇒ skip this client; the
      // other servers' entries still aggregate (no-throw, best-effort).
    }
    return { ok: true, value: acc }
  }
  const route = async <T>(
    call: (c: McpResourcesClient) => Promise<HandleResult<T>>,
  ): Promise<HandleResult<T>> => {
    // A resource uri / prompt name is owned by exactly one server, but the
    // aggregate does not know which — so it tries EVERY capable client and an
    // `ok:true` hit wins regardless of position. A non-`unsupported` failure
    // (transport / malformed / not-found) from a non-owning capable server must
    // NOT shadow a hit further down, so it is remembered but only returned when
    // no client produced a hit. `unsupported` clients (never advertised the
    // capability) are skipped entirely.
    let firstRealFailure: HandleResult<T> | undefined
    for (const c of clients) {
      const r = await call(c)
      if (r.ok) return r
      if (!isUnsupported(r) && firstRealFailure === undefined) firstRealFailure = r
    }
    return (
      firstRealFailure ?? {
        ok: false,
        reason: "unsupported",
        message: "no connected MCP server advertised the requested capability",
      }
    )
  }
  return {
    listResources: () => concat((c) => c.listResources()),
    listResourceTemplates: () => concat((c) => c.listResourceTemplates()),
    readResource: (uri) => route((c) => c.readResource(uri)),
    // B4 — CONCAT (like listResources): a dir uri may be served by exactly one
    // server, but the aggregate doesn't know which; each client already filters
    // to ITS OWN direct children, so concatenating is correct (a non-owning
    // server contributes an empty child set) and best-effort no-throw.
    readResourceDir: (uri) => concat((c) => c.readResourceDir(uri)),
    listPrompts: () => concat((c) => c.listPrompts()),
    getPrompt: (name, args) => route((c) => c.getPrompt(name, args)),
  }
}

/** Build the N3 aggregate `ResourcesHandle` over the resources-capable clients,
 *  or `undefined` when NONE qualify (so the surface leaves
 *  `DefaultToolPorts.mcpResources` unset ⇒ the five tools stay absent +
 *  byte-identical).
 *
 *  A client qualifies IFF its server advertised `resources` OR `prompts` — a
 *  server that speaks neither contributes nothing, so including it would only add
 *  an always-`unsupported` arm. SUPERVISED clients (the auto-restart path) are
 *  now INCLUDED (jun-06 RFC, limitation CLOSED): `McpReconnectSupervisor` exposes
 *  the six `resources/*`+`prompts/*` methods, re-resolving the CURRENT live client
 *  per call, so it structurally satisfies `ResourcesCapableClient` and folds into
 *  the SAME aggregate. During a reconnect gap a supervised member returns a typed
 *  `transport` failure (no throw), so it simply drops out of that one call and
 *  rejoins on recovery. */
export const resourcesHandleFor = (
  clients: ReadonlyArray<ResourcesCapableClient>,
): ResourcesHandle | undefined => {
  const capable = clients.filter((c) => c.serverSupportsResources() || c.serverSupportsPrompts())
  if (capable.length === 0) return undefined
  return aggregateResourcesHandle(capable)
}

/** A live client that BOTH satisfies the resources method-set AND can report
 *  whether its server advertised the capability (so {@link resourcesHandleFor}
 *  can drop the always-`unsupported` arms). The concrete `McpClient` satisfies
 *  it; `McpReconnectSupervisor` ALSO satisfies it (jun-06 RFC) — it now exposes
 *  the six resources/prompts methods, re-resolving the live client per call — so
 *  it is admitted into the aggregate on the supervised path. */
export interface ResourcesCapableClient extends McpResourcesClient {
  serverSupportsResources(): boolean
  serverSupportsPrompts(): boolean
}
