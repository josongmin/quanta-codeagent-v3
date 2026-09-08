/**
 * ADR-0338 — `plugin-mcp-launcher` ports.
 *
 * Closed surface for spawning the MCP servers declared in a plugin's
 * `.mcp.json` and tracking the handles for later shutdown. The launcher
 * itself NEVER calls `Bun.spawn` — it delegates to the injected
 * {@link McpLauncherPort}, which a composition root wires to either:
 *
 *   - production: a closure wrapping `@/mcp` `McpClient` +
 *     `IsolatedMcpTransport` (`dxt-ready-line`) (see
 *     `./isolated-launcher-port.ts` for the canonical factory).
 *   - test: an in-memory stub returning pre-baked handles.
 *
 * No spawn-shape is assumed here so the slice stays plane-clean — the
 * launcher cannot reach into `@/mcp/client` or `@/plugin-isolation`
 * directly. ADR-0190's plane-clean rule applies: this is a helper
 * primitive and must not import `@/agent/loop` or `@/agent/dispatch`.
 *
 * Schemas reside in `@/skill/plugin-manifest` (ADR-0039) — the launcher
 * consumes the already-parsed `MCPServerSpec` shape.
 */

import type { MCPServerSpec } from "@/skill/plugin-manifest"

/** Re-export the upstream spec under a launcher-local name so callers can
 *  type their own helper closures without crossing slice boundaries. The
 *  alias is intentional — `@/skill/plugin-manifest` is the schema source
 *  of truth (ADR-0039); we never redefine the shape here. */
export type PluginMcpServerSpec = MCPServerSpec

/** Stable handle returned by a launch attempt. Owners call
 *  {@link shutdown} when the plugin is deactivated or the session ends.
 *  Failed launches still produce a handle (`ready === false`) so the
 *  caller can report uniformly without try/catch in hot paths. */
export interface McpServerHandle {
  /** Stable identifier — `${pluginId}::${serverName}`. Composition with
   *  pluginId is the launcher's responsibility (callers pass the spec
   *  + pluginId; the handle carries the composed id back). */
  readonly serverId: string
  /** False ⇒ launch failed; the `error` field carries a reason. */
  readonly ready: boolean
  /** Present iff `ready === false`. Free-form diagnostic — NEVER thrown. */
  readonly error?: string
  /** Idempotent NO-THROW shutdown. A second call after the first resolves
   *  must be a no-op (subsequent stop on an underlying client must also
   *  be tolerated by adapters — `McpClient.stop()` already is). */
  shutdown(): Promise<void>
}

/** The single seam the launcher calls. Adapter authors implement this
 *  against the MCP client of their choice (`McpClient` + isolated
 *  transport, the `IsolatedMcpClient` facade, or a mock). The port MUST
 *  NOT throw: failures are reported through `ready: false` on the
 *  returned handle. */
export interface McpLauncherPort {
  launch(spec: PluginMcpServerSpec, opts: McpLaunchOpts): Promise<McpServerHandle>
}

/** Per-launch metadata. `pluginId` identifies which plugin owns the
 *  spawned server; `serverName` is the key under `mcpServers` in the
 *  plugin's `.mcp.json`. Both go into `serverId`. */
export interface McpLaunchOpts {
  readonly pluginId: string
  readonly serverName: string
}

/** Registry tracking every handle spawned on behalf of a plugin. The
 *  launcher pushes here; the host pulls for shutdown. In-memory by
 *  default ({@link createInMemoryPluginMcpRegistry}); persistent
 *  registries are a future ADR (cross-session re-attach). */
export interface PluginMcpRegistry {
  /** Append a handle to the plugin's list. Duplicate serverIds are a
   *  no-op (idempotency) — a re-launch should call this through the
   *  launcher, which short-circuits the spawn first. */
  track(pluginId: string, handle: McpServerHandle): void
  /** Read the handles registered for a plugin. Returns an empty array
   *  if the plugin has none — NEVER undefined. Order matches the order
   *  `track()` was called (deterministic test output). */
  handlesFor(pluginId: string): readonly McpServerHandle[]
  /** True iff a handle with `serverId` is already tracked for any
   *  plugin. Used by the launcher to skip a redundant spawn when the
   *  same `(pluginId, serverName)` pair re-enters the call site. */
  hasServerId(serverId: string): boolean
  /** Shut down every handle and clear the registry. NO-THROW — per-
   *  handle errors are swallowed (handles MUST NOT throw per
   *  {@link McpServerHandle.shutdown}, but we defend anyway). After
   *  resolution, `handlesFor()` returns `[]` for every plugin. */
  shutdownAll(): Promise<void>
}
