import type { AgentConfig } from "@/agent"
import type { TaskRegistry } from "@/subagent"

/**
 * Surface-agnostic subagent-config assembly (Tier 1 capability, ADR-0011).
 * Default OFF: `enabled !== true` ⇒ `undefined` so the key is omitted entirely
 * and the `Agent`/`Task`/`TaskOutput`/`TaskStop` tools are NOT registered
 * (loop byte-identical). When enabled, an optional integer `maxDepth` caps
 * recursion (else the runner's default).
 */

export interface SubagentConfigAssembleInput {
  /** Equivalent of `QUANTA_SUBAGENT !== undefined` — the surface decides what
   *  the "set" semantics are (env presence / CLI flag / settings toggle). */
  enabled: boolean
  /** Equivalent of `QUANTA_SUBAGENT_MAX_DEPTH` parsed → finite integer.
   *  Non-finite / undefined ⇒ `{}` (runner default). */
  maxDepth?: number | undefined
  /** Optional surface-provided TaskRegistry. When set the loop wires this
   *  exact instance into the subagent tool trio so the surface (e.g. CLI
   *  lifecycle pills) can observe `pendingIds().length` without reaching
   *  into `buildSessionFeatures`. Unset ⇒ the loop mints a fresh one and
   *  behavior is byte-identical to today. */
  taskRegistry?: TaskRegistry | undefined
}

export const buildSubagentConfigCore = (
  input: SubagentConfigAssembleInput,
): AgentConfig["subagent"] | undefined => {
  if (!input.enabled) return undefined
  const out: NonNullable<AgentConfig["subagent"]> = {}
  if (input.maxDepth !== undefined && Number.isFinite(input.maxDepth)) {
    out.maxDepth = input.maxDepth
  }
  if (input.taskRegistry !== undefined) {
    out.taskRegistry = input.taskRegistry
  }
  return out
}
