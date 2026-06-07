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
  /** ADR-0041 — when true, the six-tool parallel-worker router
   *  (`spawn_agent` / `wait_agent` / `close_agent` / `exec_command` /
   *  `write_stdin` / `send_input`) is assembled ALONGSIDE the trio (they share
   *  one TaskRegistry). This is what lets the agent fan out BACKGROUND parallel
   *  workers (vs the trio's foreground task). The surface owns the env read.
   *  Absent/false ⇒ trio only (byte-identical). */
  enable6Tools?: boolean | undefined
  /** Max concurrent `spawn_agent` background workers in flight. Only meaningful
   *  with {@link enable6Tools}. Non-finite/undefined ⇒ the dispatch default. */
  maxConcurrent?: number | undefined
  /** ADR-0145 — when true, the `spawn_batch` tool (fan a list of prompts out
   *  over parallel children in ONE call) is registered. Pairs with the parallel
   *  worker router. Absent/false ⇒ not registered. */
  enableBatchSpawn?: boolean | undefined
  /** ADR-0041/RFC-04 — when true, the `list_agents` introspection tool is
   *  registered so the agent can SEE the background workers it spawned (lists
   *  from the shared TaskRegistry; empty when none). The natural companion to
   *  {@link enable6Tools}. Absent/false ⇒ not registered. */
  enableIntrospect?: boolean | undefined
  /** §25.1 — when true, the `run_workflow` tool (LLM-authored declarative
   *  multi-agent orchestration) is registered against the shared runner. The
   *  surface owns the env read (QUANTA_WORKFLOW). Absent/false ⇒ not registered
   *  (byte-identical). */
  enableWorkflow?: boolean | undefined
  /** GAP7-4 — when true, the `spawn_agents_on_csv` tool (CSV batch fan-out) is
   *  registered against the shared runner. The surface owns the env read
   *  (QUANTA_SPAWN_AGENTS_CSV). Absent/false ⇒ not registered (byte-identical). */
  enableSpawnAgentsCsv?: boolean | undefined
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
  if (input.enable6Tools === true) {
    out.enable6Tools = true
  }
  if (input.maxConcurrent !== undefined && Number.isFinite(input.maxConcurrent)) {
    out.maxConcurrent = input.maxConcurrent
  }
  if (input.enableBatchSpawn === true) {
    out.enableBatchSpawn = true
  }
  if (input.enableIntrospect === true) {
    out.enableIntrospect = true
  }
  if (input.enableWorkflow === true) {
    out.enableWorkflow = true
  }
  if (input.enableSpawnAgentsCsv === true) {
    out.enableSpawnAgentsCsv = true
  }
  return out
}
