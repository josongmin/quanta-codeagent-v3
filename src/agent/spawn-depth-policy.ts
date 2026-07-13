/**
 * Sub-agent nesting control — depth-parameterized capability-absence (RFC
 * jul-13 §4 L1, §6.5 B). SSOT for "is THIS agent entitled to spawn tools?".
 *
 * This is the Phase-1 POLICY module. It is imported by both the tier1 spawn
 * block builders (`@/agent/tier1/*` — gate the tool families out of a child's
 * menu) and the runtime `subagent-runner` (align the typed-reject cap with the
 * same policy). Keeping the predicate here — not inlined at each gate — makes
 * the policy a single testable, mutation-covered surface.
 *
 * NOT a heuristic: the decision is a deterministic threshold on the config's
 * numeric `depth` (0 = root). No "usually leaf" estimation.
 */
import { runtimeConfig } from "@/shared/runtime-config"
import type { AgentConfig } from "./types"

/** Max agent depth that receives spawn tools (default 1 = root-only, i.e. root
 *  spawns and its children are leaves). Sourced from the typed runtime-config
 *  `maxSpawnDepth` field (env `QUANTA_MAX_SPAWN_DEPTH`, positive integer). */
export const spawnDepthCap = (): number => runtimeConfig().maxSpawnDepth

/** Is THIS agent (`config.depth`) entitled to spawn tools? depth 0 (root) ⇒ yes,
 *  depth ≥ cap ⇒ leaf. Deterministic (NOT a heuristic): `(depth ?? 0) < cap`.
 *  Absent depth ⇒ treated as 0 (root), matching the `AgentConfig.depth` contract. */
export const spawnToolsAvailable = (config: Pick<AgentConfig, "depth">): boolean =>
  (config.depth ?? 0) < spawnDepthCap()
