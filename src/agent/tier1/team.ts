/**
 * Tier-1 per-subsystem builder: TEAM LIFECYCLE block (RFC jun-6, DELTA #2).
 *
 * Returns the `team_create` / `team_delete` tools when `config.teamRegistry` is
 * wired; empty array otherwise. The two tools share the SAME `TeamRegistryPort`
 * via `teamTools(registry)` (`@/tool/team`).
 *
 * DEFAULT-OFF: `config.teamRegistry` absent ⇒ this builder returns [], so the
 * loop sees no extra tools and the ToolRegistry stays byte-identical. The
 * composition root mints + threads the registry ONLY when `QUANTA_TEAM_PEER_MSG`
 * is on. Mirrors `buildSubagentMailboxBlock`'s posture.
 *
 * SLICE FENCE: the `@/tool/team` slice takes a DUCK-TYPED `TeamRegistryWriter`
 * (it never imports `@/subagent`); the `TeamRegistryPort` structurally satisfies
 * it. This builder is the composition seam that threads the host-supplied
 * registry into the tool factory at session-start.
 */

import { spawnToolsAvailable } from "@/agent/spawn-depth"
import type { Tool } from "@/tool"
import { teamTools } from "@/tool/team"
import type { AgentConfig } from "../types"

/** Build the team-lifecycle tools when `config.teamRegistry` is wired. */
export const buildTeamBlock = (config: AgentConfig): Tool[] => {
  const registry = config.teamRegistry
  if (registry === undefined) return []
  // RFC jul-13 §4 L1 / §6.5 B Phase 1 — capability-absence: team tools absent for
  // a child at/above the spawn-depth cap. No-op at root ⇒ byte-identical.
  if (!spawnToolsAvailable(config)) return []
  return teamTools(registry)
}
