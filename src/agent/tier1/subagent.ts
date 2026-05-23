/**
 * Tier-1 per-subsystem builder: SUBAGENT block.
 *
 * Materializes the `agent` / `task_output` / `task_stop` tool trio and the
 * shared `TaskRegistry` they were wired against, plus a cleanup hook that
 * aborts all in-flight background tasks at session end.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.subagent` absent ⇒ this builder returns `undefined` and
 * the composer skips the block (byte-identical, RFC §1.2).
 */

import type { Tool } from "@/tool"
import {
  createAgentTool,
  createTaskOutputTool,
  createTaskStopTool,
  type TaskRegistry,
} from "../../subagent"
import { createSubagentRunner } from "../subagent-runner"
import type { AgentConfig } from "../types"

/** Materialized subagent block. The three tools share ONE `TaskRegistry`
 *  instance — both `agentTool.registry` and the returned `taskRegistry` point
 *  to it, so the loop can observe/inspect background tasks via the same
 *  handle the LLM-facing tools mutate. */
export interface SubagentBlock {
  /** `[agent, task_output, task_stop]` — to be merged into the registry. */
  extraTools: Tool[]
  /** The shared `TaskRegistry` instance the three tools were wired against. */
  taskRegistry: TaskRegistry
  /** Graceful shutdown hook. Aborts all currently-running background tasks
   *  (via `TaskRegistry.forceStop`) and awaits their settle via
   *  `waitForSettle`. Idempotent. */
  cleanup: () => Promise<void>
}

/** Build the subagent block from `config.subagent`. Returns `undefined` when
 *  the block is absent so the composer can skip it. */
export const buildSubagentBlock = (config: AgentConfig): SubagentBlock | undefined => {
  if (!config.subagent) return undefined

  const runner = createSubagentRunner(
    config,
    config.subagent.maxDepth !== undefined ? { maxDepth: config.subagent.maxDepth } : {},
  )

  // `createAgentTool` mints a fresh TaskRegistry when none is passed and
  // re-exposes whichever instance it used as `.registry`. We let it create
  // one and read `.registry` back, then wire the Task* tools against THAT
  // same instance so all three tools observe the same background tasks.
  // When the surface (CLI lifecycle pills) provided a `taskRegistry` we
  // thread it in here so the surface keeps a live reference — byte-identical
  // for the unset path (the conditional `registry` spread is the only
  // delta and `createAgentTool` defaults to `new TaskRegistry()` when absent).
  const agentTool = createAgentTool({
    runner,
    ...(config.subagent.maxDepth !== undefined ? { maxDepth: config.subagent.maxDepth } : {}),
    ...(config.subagent.taskRegistry !== undefined
      ? { registry: config.subagent.taskRegistry }
      : {}),
  })
  // Bind a NON-undefined local so the cleanup closure doesn't need a non-
  // null assertion on the outer `taskRegistry` (which is typed as optional
  // for callers that don't configure subagent).
  const reg = agentTool.registry
  const extraTools: Tool[] = [agentTool, createTaskOutputTool(reg), createTaskStopTool(reg)]
  const cleanup = async (): Promise<void> => {
    const ids = reg.pendingIds()
    if (ids.length === 0) return
    // S17: host-side cleanup uses `forceStop` — not the token-gated `stop`.
    // The session owner has the authority to cancel ALL pending tasks at
    // shutdown regardless of who minted them; per-task owner tokens are
    // only the LLM-facing capability gate.
    for (const id of ids) reg.forceStop(id)
    // Await all settles in parallel. waitForSettle resolves immediately for
    // already-settled tasks, so this is bounded by the slowest in-flight
    // runner observing the abort and unwinding.
    await Promise.all(ids.map((id) => reg.waitForSettle(id)))
  }
  return { extraTools, taskRegistry: reg, cleanup }
}
