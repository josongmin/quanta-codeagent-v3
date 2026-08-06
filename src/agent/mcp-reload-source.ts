/**
 * MCP tool hot-reload RELIST source (RFC-04 / RFC04-2 + RFC04-3).
 *
 * Split out of `mcp-bridge.ts` (god-module ratchet): the reload path re-lists a
 * LIVE server WITHOUT re-spawning it and re-runs the SAME connect-time bind so a
 * reload can never diverge from connect in tool-name / converter / trust logic.
 * The reload controller's rebuild port calls {@link relistMcpTools} to produce
 * the fresh MCP-tool array it then feeds into the connect-time `buildToolingCore`
 * assembly — there is NO reload-only converter/collision/trust path.
 */

import type { McpClient, McpReconnectSupervisor } from "@/mcp"
import { errMessage, logger } from "@/shared"
import type { Tool } from "@/tool"
import {
  type McpToolBindOpts,
  mcpToolToTool,
  mcpToolToToolSupervised,
  supervisedTasksToolsFor,
  tasksToolsFor,
} from "./mcp-bridge"

/** F1 — the registry is a name-keyed Map with last-write-wins, and
 *  {@link mcpToolName} sanitizes free-form server/tool names through
 *  `replace(/[^A-Za-z0-9_]+/g, "_")`. So two DISTINCT source tools — across
 *  servers (`my-srv` vs `my_srv`) or on one server (`get.x` vs `get-x`) — can
 *  collapse to the SAME bridged name and one would be SILENTLY shadowed (no log,
 *  no `/mcp` record, capability withheld).
 *
 *  This pass walks the bridged tools IN LOAD ORDER and, when a name is already
 *  taken, DISAMBIGUATES the later tool by appending the smallest `_<n>` (n≥2)
 *  suffix that is itself free — so BOTH tools stay callable (the registry no
 *  longer drops one). The first tool to claim a name keeps it verbatim, so the
 *  non-colliding common case is BYTE-IDENTICAL (every name unchanged). Each
 *  rename is `logger.warn`'d AND recorded so the collision is observable, never
 *  silent. Renaming only the `name` field is safe: the tool's `execute` dispatches
 *  on the captured ORIGINAL MCP tool name (`def.name`), not on this registry key.
 *
 *  Lives HERE (with the relist assembly) because it is the SHARED collision logic
 *  BOTH connect (`loadMcpTools`) and reload (`relistMcpTools`) run — no reload-only
 *  disambiguator. Returns the (possibly renamed) tools plus the collision records
 *  for any observability surface (`/mcp`). */
export const disambiguateMcpToolNames = (
  tools: Tool[],
): { tools: Tool[]; collisions: { kept: string; renamed: string; to: string }[] } => {
  const seen = new Set<string>()
  const collisions: { kept: string; renamed: string; to: string }[] = []
  const out = tools.map((t) => {
    if (!seen.has(t.name)) {
      seen.add(t.name)
      return t
    }
    let n = 2
    let candidate = `${t.name}_${n}`
    while (seen.has(candidate)) {
      n += 1
      candidate = `${t.name}_${n}`
    }
    seen.add(candidate)
    collisions.push({ kept: t.name, renamed: t.name, to: candidate })
    logger.warn(
      `mcp: tool-name collision on "${t.name}" — a second tool maps to the same ` +
        `identifier; renaming the later one to "${candidate}" so both stay callable`,
    )
    return { ...t, name: candidate }
  })
  return { tools: out, collisions }
}

/** RFC04-2/3 (hot-reload) — best-effort invoke of the optional reload-source sink
 *  with the {@link McpReloadableSource} the caller built. Wrapped so a hostile
 *  sink can never escape the load's success path. Absent ⇒ no-op (byte-identical).
 *  Shared by BOTH `loadMcpTools` load paths (single-client + supervised) so the
 *  emit goes through ONE point. Lives with the relist assembly (not the bridge)
 *  so the bridge stays under the god-module ratchet. */
export const emitReloadSource = (
  onReloadSource: ((source: McpReloadableSource) => void) | undefined,
  server: string,
  source: McpReloadableSource,
): void => {
  if (onReloadSource === undefined) return
  try {
    onReloadSource(source)
  } catch (e) {
    logger.warn(`mcp: onReloadSource sink threw for "${server}": ${errMessage(e)}`)
  }
}

/** One reloadable MCP source: a live server whose tool list can be RE-listed and
 *  RE-bridged without re-spawning the process. `relist` re-runs the SAME
 *  connect-time bind over the SAME live client. It MUST reject on any relist
 *  failure (transport / malformed page) so the reload controller retains
 *  last-known-good (never a partial/empty publish). */
export interface McpReloadableSource {
  relist(): Promise<Tool[]>
}

/** Build a reloadable source over a live SINGLE-CLIENT `McpClient`. Re-lists via
 *  `client.listTools()` (which handles FULL pagination internally, the SAME path
 *  connect used) and re-binds each def with `mcpToolToTool` under the SAME
 *  `bindOpts` connect derived — so the relisted surface is byte-for-byte the
 *  assembly connect would produce for the current server tool list. The tasks
 *  surface is re-derived per relist (a server that unlocked `tasks/*` after an
 *  auth now bridges them). Rejects on any `listTools` failure. */
export const reloadableSingleClientSource = (
  client: McpClient,
  serverName: string,
  bindOpts: McpToolBindOpts,
): McpReloadableSource => ({
  relist: async () => {
    const defs = await client.listTools()
    const tools = defs.map((def) => mcpToolToTool(client, def, serverName, bindOpts))
    tools.push(...tasksToolsFor(client))
    return tools
  },
})

/** Build a reloadable source over an auto-restart `McpReconnectSupervisor`
 *  (RFC04 supervised extension). Mirrors {@link reloadableSingleClientSource},
 *  but binds to the SUPERVISOR's STABLE handle instead of a concrete (mortal)
 *  `McpClient`: `sup.listTools()` forwards to the CURRENT live client (as
 *  `supervisedTasksToolsFor` does for `tasks/*`), so a relist always re-lists the
 *  live server — even if auto-restart swapped the underlying client since the
 *  source was created. Each relisted def is re-bridged with
 *  {@link mcpToolToToolSupervised} (routing through the supervisor, restart-safe)
 *  under the SAME connect-time `bindOpts`, and the supervised `tasks/*` surface
 *  is re-derived per relist. Rejects on any `listTools` failure so the reload
 *  controller retains last-known-good (never a partial/empty publish). */
export const reloadableSupervisedSource = (
  sup: McpReconnectSupervisor,
  serverName: string,
  bindOpts: McpToolBindOpts,
): McpReloadableSource => ({
  relist: async () => {
    const defs = await sup.listTools()
    const tools = defs.map((def) => mcpToolToToolSupervised(sup, def, serverName, bindOpts))
    tools.push(...supervisedTasksToolsFor(sup))
    return tools
  },
})

/** Relist EVERY reloadable source and re-run the SAME collision disambiguation
 *  the connect path uses, returning the full re-bridged tool set. Any source's
 *  `relist` rejection PROPAGATES (the controller then retains last-known-good). */
export const relistMcpTools = async (sources: readonly McpReloadableSource[]): Promise<Tool[]> => {
  const all: Tool[] = []
  for (const s of sources) all.push(...(await s.relist()))
  // F1 — SAME disambiguation as the connect path: a relisted tool that sanitizes
  // to an already-taken identifier gets a deterministic `_<n>` suffix.
  return disambiguateMcpToolNames(all).tools
}
