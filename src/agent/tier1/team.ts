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

import type { Tool } from "@/tool"
import { teamTools } from "@/tool/team"
import type { AgentConfig } from "../types"

/** Build the team-lifecycle tools when `config.teamRegistry` is wired. */
export const buildTeamBlock = (config: AgentConfig): Tool[] => {
  const registry = config.teamRegistry
  if (registry === undefined) return []
  // rev.4 §4.4 / §5.1 — capability projection moved to the single
  // `projectSpawnTools` filter at the `features.ts` seam (SSOT). Both team tools
  // are minted here; for a leaf the filter removes ONLY `team_create` (the spawn
  // vector) and KEEPS `team_delete` (management — the leaf must manage its own
  // team sub-state). This is the §5.1 N2 fix vs the old blanket gate.
  return teamTools(registry)
}
