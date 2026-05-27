/**
 * ADR-0338 — `launchPluginMcpServers`.
 *
 * Given a plugin manifest carrying a `.mcp.json`-parsed `mcpServers`
 * record (already validated by `@/skill/plugin-manifest` `MCPRootSchema`
 * under ADR-0039), spawn each declared server through the injected
 * {@link McpLauncherPort} and track every handle on the supplied
 * {@link PluginMcpRegistry}.
 *
 * Invariants:
 *
 *  1. NO-THROW. The function never throws. A port that throws produces
 *     a `ready: false` handle. A registry mutation that throws is
 *     caught and skipped (the handle is still in the return array so
 *     the caller can perform best-effort shutdown).
 *
 *  2. Per-server isolation. A failure to launch server A does NOT skip
 *     server B. Every entry in `mcpServers` is attempted.
 *
 *  3. Idempotent. If the registry already has a handle for
 *     `${pluginId}::${serverName}`, the launch is skipped and the
 *     existing handle is reused (lookup via `handlesFor` + `serverId`
 *     match). This lets activation events fire twice without spawning
 *     two processes for the same plugin server.
 *
 *  4. Deterministic order. Servers are launched in the **lexicographic**
 *     order of their keys under `mcpServers`. JS object iteration order
 *     for string keys is insertion-ordered, but plugin manifests may
 *     come from a streamed parse that preserves source order; for test
 *     determinism we explicitly sort.
 *
 * This is a primitive. ADR-0338 explicitly does NOT trigger this from
 * any event in the loop — the wiring of "plugin activation event ⇒
 * call launchPluginMcpServers" belongs to a follow-up ADR.
 */

import type { PluginManifest } from "@/skill/plugin-manifest"
import type {
  McpLauncherPort,
  McpServerHandle,
  PluginMcpRegistry,
  PluginMcpServerSpec,
} from "./types"

/** Compose the canonical `serverId` from plugin + server names. Exposed
 *  so tests and adapter authors can build the same id without re-
 *  inventing the joiner. The `::` separator is unambiguous because
 *  plugin names follow `^[a-z0-9][a-z0-9._-]*$` (no colons — see
 *  `PluginManifestSchema` in `@/skill/plugin-manifest`). */
export const composeServerId = (pluginId: string, serverName: string): string =>
  `${pluginId}::${serverName}`

const safeTrack = (
  registry: PluginMcpRegistry,
  pluginId: string,
  handle: McpServerHandle,
): void => {
  try {
    registry.track(pluginId, handle)
  } catch {
    // NO-THROW invariant — a misbehaving registry must not break the
    // launch path. The handle is still in the return array, so the
    // caller can run handle.shutdown() itself if needed.
  }
}

const failedHandle = (serverId: string, error: string): McpServerHandle => ({
  serverId,
  ready: false,
  error,
  shutdown: async () => {
    // Failed launches own no resources — shutdown is a guaranteed
    // no-op. We still need a function so the handle satisfies the port.
  },
})

const safeLaunchOne = async (
  port: McpLauncherPort,
  spec: PluginMcpServerSpec,
  pluginId: string,
  serverName: string,
): Promise<McpServerHandle> => {
  const serverId = composeServerId(pluginId, serverName)
  try {
    const handle = await port.launch(spec, { pluginId, serverName })
    // Defend against an adapter that returns a wrong serverId — the
    // registry uses serverId as the dedupe key, so an inconsistent id
    // would break idempotency. We rewrap if needed.
    if (handle.serverId === serverId) return handle
    return {
      serverId,
      ready: handle.ready,
      ...(handle.error !== undefined ? { error: handle.error } : {}),
      shutdown: () => handle.shutdown(),
    }
  } catch (e) {
    return failedHandle(serverId, e instanceof Error ? e.message : String(e))
  }
}

/** Launch every server declared in the manifest's `mcpServers` record.
 *  Returns the handle list in deterministic order. */
export const launchPluginMcpServers = async (
  manifest: PluginManifest,
  registry: PluginMcpRegistry,
  port: McpLauncherPort,
): Promise<readonly McpServerHandle[]> => {
  const mcp = manifest.mcpServers
  if (mcp === undefined) return []
  const names = Object.keys(mcp).sort()
  if (names.length === 0) return []

  const pluginId = manifest.name
  const out: McpServerHandle[] = []

  for (const serverName of names) {
    const serverId = composeServerId(pluginId, serverName)
    if (registry.hasServerId(serverId)) {
      // Idempotency — reuse the already-tracked handle if we can find
      // it. handlesFor() returns ALL handles for the plugin; we pick
      // the one matching this serverId.
      const existing = registry.handlesFor(pluginId).find((h) => h.serverId === serverId)
      if (existing !== undefined) {
        out.push(existing)
        continue
      }
      // serverId is in the dedupe set but not in the plugin's handle
      // list (some other plugin happened to own it?) — defensive: still
      // skip the spawn but emit a failed-handle marker so the caller
      // sees the conflict.
      out.push(
        failedHandle(
          serverId,
          `serverId ${serverId} already claimed by another plugin in the registry`,
        ),
      )
      continue
    }

    const spec = mcp[serverName]
    if (spec === undefined) {
      // Should be impossible (we just iterated the keys), but
      // noUncheckedIndexedAccess forces the guard.
      out.push(failedHandle(serverId, "spec missing for server"))
      continue
    }
    const handle = await safeLaunchOne(port, spec, pluginId, serverName)
    safeTrack(registry, pluginId, handle)
    out.push(handle)
  }
  return out
}
