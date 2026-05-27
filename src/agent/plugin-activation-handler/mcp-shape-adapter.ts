/**
 * ADR-0340 — MCP server shape adapter (ADR-0336 → ADR-0039 / ADR-0338).
 *
 * `@/agent/plugin-discovery` (ADR-0336) and `@/skill/plugin-manifest`
 * (ADR-0039) currently define two **different** shapes for the same
 * concept ("declared MCP server"):
 *
 *   ADR-0336: `PluginManifest.mcpServers?: readonly { name: string;
 *              command?: string }[]`          (array, command optional)
 *   ADR-0039: `MCPServerSpec = { command: string;  args: string[];
 *              env?: Record<string,string> }`   (strict, command required,
 *              args mandatory)
 *
 * ADR-0338's `launchPluginMcpServers` consumes the ADR-0039 shape (it
 * accepts a full ADR-0039 `PluginManifest`). The activation handler
 * (this slice) receives ADR-0336 manifests from `PluginRegistryPort`,
 * so it must adapt.
 *
 * This adapter is a TEMPORARY seam. A follow-up ADR (ADR-0341) unifies
 * the two shapes; once landed, this adapter is RETIRED in one PR — the
 * handler will pass the ADR-0339-shape manifest to `port.launch`
 * directly.
 *
 * # Semantics
 *
 * - An entry with `command === undefined` or `command === ""` is
 *   DROPPED silently (the ADR-0336 shape allows a name-only declaration
 *   for future "deferred resolution" semantics; the launcher needs a
 *   real command, so we cannot lift the entry without inventing data).
 * - `args` defaults to `[]` (ADR-0039 strict requires the array; we
 *   never invent positional arguments).
 * - `env` is OMITTED entirely when the ADR-0336 shape doesn't carry
 *   one — `MCPServerSpec.env` is optional, so the absent slot is the
 *   correct projection.
 * - The serverName carried back is the ADR-0336 `entry.name` verbatim
 *   (no normalization, no kebab-coercion — the launcher already trusts
 *   the name for `composeServerId`).
 *
 * NO-THROW. Returns a fresh array per call (no aliasing into the input).
 * Empty / undefined input ⇒ `[]`. Non-array input ⇒ `[]`.
 */

import type { PluginMcpServer } from "@/agent/plugin-discovery"
import type { MCPServerSpec } from "@/skill/plugin-manifest"

/**
 * One adapted entry: the server name (becomes the registry's serverName)
 * + the strict ADR-0039 spec the launcher port consumes.
 */
export interface AdaptedMcpEntry {
  readonly name: string
  readonly spec: MCPServerSpec
}

/**
 * Convert an ADR-0336 `PluginManifest.mcpServers` array into the strict
 * ADR-0039 `MCPServerSpec` shape the launcher port accepts. Entries
 * lacking a non-empty `command` are dropped. Order preserved.
 *
 * @param sources — ADR-0336 array (possibly undefined / not-an-array).
 * @returns A new readonly array of `{ name, spec }` pairs. Never throws.
 */
export const adaptMcpServersToSpec = (
  sources: readonly PluginMcpServer[] | undefined,
): readonly AdaptedMcpEntry[] => {
  if (!Array.isArray(sources)) return []
  if (sources.length === 0) return []
  const out: AdaptedMcpEntry[] = []
  for (const entry of sources) {
    if (entry === null || entry === undefined) continue
    const name = entry.name
    if (typeof name !== "string" || name.length === 0) continue
    const command = entry.command
    if (typeof command !== "string" || command.length === 0) continue
    // ADR-0039 strict shape: args mandatory (empty allowed), env optional.
    const spec: MCPServerSpec = { command, args: [] }
    out.push({ name, spec })
  }
  return out
}
