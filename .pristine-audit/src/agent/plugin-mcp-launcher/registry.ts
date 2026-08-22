/**
 * ADR-0338 — in-memory {@link PluginMcpRegistry}.
 *
 * Tracks every handle the launcher hands back, indexed by `pluginId`.
 * Used by:
 *
 *   - the launcher itself: a `hasServerId()` check short-circuits a
 *     redundant spawn when the same `(pluginId, serverName)` pair
 *     re-enters (idempotency on activation events that fire twice).
 *   - the host: on plugin deactivation / session shutdown, the host
 *     calls `shutdownAll()` to release every spawned server.
 *
 * Storage is a `Map<pluginId, McpServerHandle[]>` + a flat `Set<serverId>`
 * for O(1) duplicate detection. Both are reset by `shutdownAll()`.
 *
 * NO-THROW: every shutdown is wrapped — a misbehaving handle (a thrown
 * promise rejection) cannot block the remaining shutdowns. Errors are
 * silently swallowed; a structured logger here would risk leaking
 * sensitive plugin paths to a turn-loop log. Callers that want
 * observability should wrap their handles with a logging decorator at
 * adapter time (see `./isolated-launcher-port.ts`).
 */

import type { McpServerHandle, PluginMcpRegistry } from "./types"

/** Build a fresh in-memory registry. State is private to the closure —
 *  no global singleton; the composition root owns the lifetime. */
export const createInMemoryPluginMcpRegistry = (): PluginMcpRegistry => {
  const byPlugin = new Map<string, McpServerHandle[]>()
  const serverIds = new Set<string>()

  const track = (pluginId: string, handle: McpServerHandle): void => {
    if (serverIds.has(handle.serverId)) return // idempotent
    serverIds.add(handle.serverId)
    const existing = byPlugin.get(pluginId)
    if (existing === undefined) {
      byPlugin.set(pluginId, [handle])
      return
    }
    existing.push(handle)
  }

  const handlesFor = (pluginId: string): readonly McpServerHandle[] => {
    const list = byPlugin.get(pluginId)
    if (list === undefined) return []
    // Return a freshly-cloned readonly view so callers cannot mutate the
    // internal array (and so iteration during shutdownAll() is stable
    // even if the host concurrently calls track()).
    return list.slice()
  }

  const hasServerId = (serverId: string): boolean => serverIds.has(serverId)

  const shutdownAll = async (): Promise<void> => {
    // Snapshot the handles before clearing so a track() racing with
    // shutdownAll cannot cause a handle to be leaked. Order: handles
    // first, then clear.
    const handles: McpServerHandle[] = []
    for (const list of byPlugin.values()) {
      for (const h of list) handles.push(h)
    }
    byPlugin.clear()
    serverIds.clear()
    // Sequential shutdown — MCP server stop is rarely parallel-safe
    // (SIGTERM → SIGKILL grace window doesn't compose). Cheap enough.
    for (const h of handles) {
      try {
        await h.shutdown()
      } catch {
        // NO-THROW invariant: shutdown errors are swallowed. See module
        // doc for the rationale (no logger here).
      }
    }
  }

  return { track, handlesFor, hasServerId, shutdownAll }
}
