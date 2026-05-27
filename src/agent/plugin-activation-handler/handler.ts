/**
 * ADR-0340 — `createPluginActivationHandler`.
 *
 * Closes the gap between ADR-0336/0338/0339 primitives by producing a
 * single closure that, given a `pluginId`:
 *
 *   1. Looks up the manifest via `PluginRegistryPort` (ADR-0336).
 *   2. Spawns each declared MCP server via the injected `McpLauncherPort`
 *      (ADR-0338) — using {@link adaptMcpServersToSpec} to bridge the
 *      ADR-0336 / ADR-0039 shape gap.
 *   3. Resolves the manifest's declared skills via
 *      `resolvePluginSkillsForActivation` (ADR-0339), with optional
 *      `skill_activation` event emission.
 *
 * # Invariants
 *
 *  1. NO-THROW. Every external call (registry lookup, port.launch,
 *     skill resolver) is wrapped. Failures produce empty arrays in the
 *     result; the caller never sees a thrown exception.
 *
 *  2. Idempotent per pluginId. The closure holds a `Map<pluginId,
 *     ActivationResult>` cache. A second `activate("github")` returns
 *     the FIRST result (no re-spawn, no re-resolve, no re-emit). This
 *     is essential because:
 *       - the same `plugin://x` mention may appear twice in one turn,
 *       - the loop may re-evaluate the mention list on a retry,
 *       - composite activation across plugins can encounter the same
 *         id when a plugin is declared by multiple mention sources.
 *     The launcher's internal `hasServerId` idempotency is a second
 *     layer of defense; the handler-level cache is the primary.
 *
 *  3. Step isolation. Lookup miss ⇒ empty result. MCP step failure
 *     does NOT abort the skill step. Skill step failure does NOT
 *     un-cache the MCP handles. Per-step try/catch.
 *
 *  4. Caller-side composition. The handler does NOT mutate any global
 *     state — `mcpHandles` are returned for the caller to retain on its
 *     `PluginMcpRegistry`; `resolvedSkills` are returned for the caller
 *     to union with its existing active-skills list via
 *     `unionActiveSkills` (ADR-0339).
 *
 * # Slice-fence
 *
 * This module MAY import `@/agent/plugin-discovery`,
 * `@/agent/plugin-mcp-launcher`, `@/agent/plugin-skill-extension`,
 * `@/skill/plugin-manifest`, `@/skill/registry-readonly`. It MUST NOT
 * import `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt`, or
 * `@/agent/types` (would create a circular dependency through AgentConfig).
 */

import type {
  McpLauncherPort,
  McpServerHandle,
  PluginMcpRegistry,
} from "@/agent/plugin-mcp-launcher"
import { composeServerId } from "@/agent/plugin-mcp-launcher"
import {
  type ActiveSkillDescriptor,
  resolvePluginSkillsForActivation,
} from "@/agent/plugin-skill-extension"
import { adaptMcpServersToSpec } from "./mcp-shape-adapter"
import type {
  ActivationCallOpts,
  ActivationHandler,
  ActivationHandlerConfig,
  ActivationResult,
} from "./types"

/** NO-THROW lookup wrapper. PluginRegistryPort is contractually
 *  NO-THROW (ADR-0336) but a hostile/buggy adapter may still throw —
 *  belt-and-suspenders. */
const safeLookup = (
  cfg: ActivationHandlerConfig,
  pluginId: string,
): ReturnType<ActivationHandlerConfig["pluginRegistry"]["lookup"]> => {
  try {
    return cfg.pluginRegistry.lookup(pluginId)
  } catch {
    return null
  }
}

/** Build a fresh failed handle. Used when the launcher port throws (the
 *  port is contractually NO-THROW but defense in depth). The launcher
 *  slice has the same helper internally; we duplicate locally so we
 *  never reach into the launcher's private internals. */
const buildFailedHandle = (serverId: string, error: string): McpServerHandle => ({
  serverId,
  ready: false,
  error,
  shutdown: async () => {
    // failed launches own no resources — guaranteed no-op
  },
})

/** Track one handle on the registry, NO-THROW. */
const safeTrack = (
  registry: PluginMcpRegistry,
  pluginId: string,
  handle: McpServerHandle,
): void => {
  try {
    registry.track(pluginId, handle)
  } catch {
    // registry misbehaving — handle still in result array
  }
}

/** Launch one server directly through the port (we bypass the launcher's
 *  manifest-driven driver because ADR-0336 manifest shape differs from
 *  ADR-0039 manifest shape — see `./mcp-shape-adapter.ts`). NO-THROW. */
const launchOne = async (
  port: McpLauncherPort,
  pluginId: string,
  serverName: string,
  spec: import("@/skill/plugin-manifest").MCPServerSpec,
): Promise<McpServerHandle> => {
  const expectedId = composeServerId(pluginId, serverName)
  try {
    const handle = await port.launch(spec, { pluginId, serverName })
    // Defend against an adapter returning a non-canonical serverId
    // (would break the registry's dedupe set). Rewrap if mismatched.
    if (handle.serverId === expectedId) return handle
    return {
      serverId: expectedId,
      ready: handle.ready,
      ...(handle.error !== undefined ? { error: handle.error } : {}),
      shutdown: () => handle.shutdown(),
    }
  } catch (e) {
    return buildFailedHandle(expectedId, e instanceof Error ? e.message : String(e))
  }
}

/** Spawn every adapted MCP server for the plugin. Skips already-tracked
 *  serverIds (idempotency through the registry, mirrors ADR-0338). */
const runMcpStep = async (
  cfg: ActivationHandlerConfig,
  pluginId: string,
  sources: readonly import("@/agent/plugin-discovery").PluginMcpServer[] | undefined,
): Promise<readonly McpServerHandle[]> => {
  const port = cfg.mcpLauncherPort
  const registry = cfg.mcpRegistry
  if (port === undefined || registry === undefined) return []
  const adapted = adaptMcpServersToSpec(sources)
  if (adapted.length === 0) return []

  const out: McpServerHandle[] = []
  for (const { name: serverName, spec } of adapted) {
    const serverId = composeServerId(pluginId, serverName)
    if (registry.hasServerId(serverId)) {
      const existing = registry.handlesFor(pluginId).find((h) => h.serverId === serverId)
      if (existing !== undefined) {
        out.push(existing)
        continue
      }
      out.push(
        buildFailedHandle(
          serverId,
          `serverId ${serverId} already claimed by another plugin in the registry`,
        ),
      )
      continue
    }
    const handle = await launchOne(port, pluginId, serverName, spec)
    safeTrack(registry, pluginId, handle)
    out.push(handle)
  }
  return out
}

/** Resolve the manifest's declared skills via ADR-0339. NO-THROW. */
const runSkillStep = (
  cfg: ActivationHandlerConfig,
  skills: readonly string[] | undefined,
  turnId: string | undefined,
  now: () => number,
): readonly ActiveSkillDescriptor[] => {
  const registry = cfg.skillRegistry
  if (registry === undefined) return []
  if (!Array.isArray(skills) || skills.length === 0) return []
  try {
    // ADR-0339 trigger="auto" — plugin activation IS the trigger.
    // exactOptionalPropertyTypes: drop turnId when undefined so the
    // opts object stays clean (mirrors the resolver's own pattern).
    const opts =
      turnId === undefined
        ? { trigger: "auto" as const, at: now() }
        : { trigger: "auto" as const, at: now(), turnId }
    return resolvePluginSkillsForActivation(
      skills,
      cfg.emit === undefined ? { registry } : { registry, emit: cfg.emit },
      opts,
    )
  } catch {
    return []
  }
}

/**
 * Build the per-session activation closure. State (the idempotency
 * cache) lives in the closure — composition root owns the lifetime.
 *
 * @param cfg — closed config. `pluginRegistry` is mandatory; other deps
 *              degrade the corresponding step to a no-op when absent.
 * @returns the activation handler closure. NO-THROW. Idempotent.
 */
export const createPluginActivationHandler = (cfg: ActivationHandlerConfig): ActivationHandler => {
  const now = cfg.now ?? Date.now
  const cache = new Map<string, ActivationResult>()

  return async (pluginId: string, opts?: ActivationCallOpts): Promise<ActivationResult> => {
    // Defensive: malformed id ⇒ empty result. Cache miss because we
    // never write the key.
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      return {
        pluginId: typeof pluginId === "string" ? pluginId : "",
        mcpHandles: [],
        resolvedSkills: [],
      }
    }

    // Idempotency — cached result wins.
    const cached = cache.get(pluginId)
    if (cached !== undefined) return cached

    const manifest = safeLookup(cfg, pluginId)
    if (manifest === null) {
      const empty: ActivationResult = { pluginId, mcpHandles: [], resolvedSkills: [] }
      cache.set(pluginId, empty)
      return empty
    }

    const mcpHandles = await runMcpStep(cfg, pluginId, manifest.mcpServers)
    const resolvedSkills = runSkillStep(cfg, manifest.skills, opts?.turnId, now)

    const result: ActivationResult = { pluginId, mcpHandles, resolvedSkills }
    cache.set(pluginId, result)
    return result
  }
}
