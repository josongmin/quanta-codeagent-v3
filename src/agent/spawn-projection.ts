/**
 * Sub-agent nesting control — SINGLE capability-projection filter (RFC
 * docs/plans/jul-13-subagent-nesting-control.md §4.4 / §5.1, rev.4 SSOT).
 *
 * rev.4 replaces the four per-builder `if (!spawnToolsAvailable(config)) return`
 * gates (one in each of `tier1/{subagent,subagent-batch,team,delegate}.ts`) with
 * ONE filter applied where `buildSessionFeatures` finalizes `extraTools`. The
 * builders now UNCONDITIONALLY mint their tools; this filter is the sole owner of
 * capability projection. A new spawn tool only has to be added to
 * {@link SPAWN_TOOL_NAMES} — there is no per-builder gate to forget (the class of
 * regression the {@link SPAWN_TOOL_NAMES} meta-pin exists to catch).
 *
 * CREATION-ONLY (§5.1 — the N2 audit fix): the set names the CREATION-authority
 * (spawn) tools ONLY. Management/observation tools a leaf needs to manage AND
 * observe its OWN already-spawned sub-state SURVIVE — e.g. `team_delete`,
 * `task_output`, `task_stop`, `wait_agent`, `close_agent`, `send_input`. Only the
 * spawn VECTORS are withheld from a leaf. `agent`/`spawn_agent` are the trio vs
 * 6-tool creation variants; `team_create` is the team spawn vector while
 * `team_delete` (management) is deliberately NOT in the set.
 *
 * AUTHORITY: this projection is an OPTIMIZATION (§4 — a leaf never SEES the tool,
 * cheaper than a runtime bounce). The AUTHORITATIVE boundary is the
 * subagent-runner reject (`childDepthOf(parent)` vs `effectiveCap`), which is
 * UNCHANGED and still denies a forced/held-runner spawn the projection can't see.
 */

import type { Tool } from "@/tool"
import { canExposeSpawnTools, effectiveCap } from "./spawn-depth"
import type { AgentConfig } from "./types"

/** The CREATION-authority (spawn-descendant) tool names — the ONLY tools a leaf
 *  loses. Every tool a tier1 spawn builder mints that CREATES a new child agent
 *  edge MUST be listed here; management/observation tools (`team_delete`,
 *  `task_output`/`task_stop`, `wait_agent`/`close_agent`/`send_input`, …) are
 *  DELIBERATELY absent so a leaf keeps authority over its own sub-state (§5.1).
 *
 *  SSOT — a manifest spawn vector not listed here is caught by the NON-CIRCULAR
 *  meta-pin in `subagent-nesting-single-filter-projection-hellgate.test.ts`, which
 *  cross-checks this set against the INDEPENDENT `GATED_TOOLS` `risk:"spawns-subagent"`
 *  classification (every such tool must be in this set OR an explicit management
 *  exception). This is the guard `subagent_fork`/`side_agent_spawn` originally
 *  slipped past — the earlier enumeration-only pin was circular (it pre-filtered to
 *  names already in the set) and could not see a forgotten one. */
export const SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "agent", // trio creation tool (tier1/subagent.ts)
  "spawn_agent", // 6-tool creation variant (tier1/subagent.ts, ADR-0041)
  "spawn_batch", // batch fan-out creation (tier1/subagent-batch.ts)
  "spawn_agents_on_csv", // one child per CSV row (tier1/subagent.ts)
  "run_workflow", // each workflow `agent` step forks a child (tier1/subagent.ts)
  "delegate", // synchronous delegation child (tier1/delegate.ts)
  "team_create", // team spawn vector (tier1/team.ts) — NOT team_delete (§5.1)
  "branch_search", // speculative candidate fork (ADR-0084, branch-search-runner.ts) — D1 defense-in-depth
  "subagent_fork", // background fork creation (tier1/subagent-bg.ts) — runtime-backstopped by the runner reject, but a leaf must not SEE it either
  "side_agent_spawn", // persistent side-agent daemon creation (tier1/side-agent.ts) — a leaf must not mint daemons (the daemon-creation path is otherwise depth-blind)
])

/** rev.4 §4.4 SINGLE capability-projection filter. Applied ONCE where
 *  `buildSessionFeatures` finalizes `extraTools`. When THIS agent may still
 *  expose spawn tools (`canExposeSpawnTools(depth, effectiveCap(requested))` —
 *  the IDENTICAL min-cap expression the old per-builder gate `spawnToolsAvailable`
 *  used), the tools pass through UNCHANGED (no-op — byte-identical to today at the
 *  root under default cap 1). Otherwise the CREATION tools ({@link SPAWN_TOOL_NAMES})
 *  are removed while every management/observation and non-spawn tool survives.
 *
 *  Behavior-equivalent to the removed 4-gate state EXCEPT team management/observe
 *  tools (e.g. `team_delete`) now SURVIVE for a leaf (the §5.1 N2 fix). */
export const projectSpawnTools = (
  tools: Tool[],
  config: Pick<AgentConfig, "depth" | "subagent">,
): Tool[] =>
  canExposeSpawnTools(config.depth ?? 0, effectiveCap(config.subagent?.maxDepth))
    ? tools
    : tools.filter((t) => !SPAWN_TOOL_NAMES.has(t.name))
