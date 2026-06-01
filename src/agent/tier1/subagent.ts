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
  type TaskOutputTimeoutPolicy,
  type TaskRegistry,
  type WaitTimeoutPolicy,
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
  /** B2/B3 — the 6-tool (`spawn_agent`/`wait_agent`/…) dispatch deps the host
   *  config asked for, surfaced for whatever assembles a `Subagent6Deps`. The
   *  trio tools above are wired directly in this builder; the 6-tool router
   *  has no live assembly site in the loop today, so the two 6-tool-only knobs
   *  (`waitTimeoutPolicy` for `wait_agent`, `maxConcurrent` for `spawn_agent`)
   *  are EXPOSED here rather than dropped. Both omitted when the corresponding
   *  config field is absent ⇒ the consumer sees `{}` and the 6-tool defaults
   *  (30s policy / unlimited concurrency) apply — byte-identical to today. */
  subagent6Deps: {
    waitTimeoutPolicy?: WaitTimeoutPolicy
    maxConcurrent?: number
  }
}

/** Adapt a {@link WaitTimeoutPolicy} (handlers-6 slice) onto the structurally
 *  identical {@link TaskOutputTimeoutPolicy} (task-tools slice). The two types
 *  are deliberately kept apart (task-tools stays zod-only; handlers-6 pulls in
 *  `bun` Subprocess types) but the host wires the SAME band into both — this is
 *  the single adaptation point. Pure field copy. */
const toTaskOutputPolicy = (p: WaitTimeoutPolicy): TaskOutputTimeoutPolicy => ({
  minMs: p.minMs,
  maxMs: p.maxMs,
  defaultMs: p.defaultMs,
})

/** Build the subagent block from `config.subagent`. Returns `undefined` when
 *  the block is absent so the composer can skip it. */
export const buildSubagentBlock = (config: AgentConfig): SubagentBlock | undefined => {
  if (!config.subagent) return undefined

  // B1 — `toolNamespace` (when present) is threaded into the runner so forked
  // children expose SCOPED tool names. Absent ⇒ raw names (byte-identical):
  // the conditional spread keeps the options object empty on the unset path.
  const runner = createSubagentRunner(config, {
    ...(config.subagent.maxDepth !== undefined ? { maxDepth: config.subagent.maxDepth } : {}),
    ...(config.subagent.toolNamespace !== undefined
      ? { toolNamespace: config.subagent.toolNamespace }
      : {}),
  })

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
  // B2 — the SAME `{minMs,maxMs,defaultMs}` band the host configured for the
  // 6-tool `wait_agent` clamp is also fed into the trio's `task_output`
  // blocking clamp. `WaitTimeoutPolicy` and `TaskOutputTimeoutPolicy` are
  // distinct nominal types kept on separate slices (handlers-6 vs task-tools)
  // but share an identical structural shape; we adapt explicitly so a single
  // config knob clamps both families. Absent ⇒ `createTaskOutputTool(reg)` is
  // called 1-arg exactly as before (its own DEFAULT policy applies) —
  // byte-identical to today.
  const wtp = config.subagent.waitTimeoutPolicy
  const taskOutputTool =
    wtp !== undefined
      ? createTaskOutputTool(reg, toTaskOutputPolicy(wtp))
      : createTaskOutputTool(reg)
  const extraTools: Tool[] = [agentTool, taskOutputTool, createTaskStopTool(reg)]
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
  // B2/B3 — surface the 6-tool-only knobs for a `Subagent6Deps` assembler.
  // Conditional-spread so absent config fields ⇒ `{}` (the consumer falls back
  // to the 6-tool handler defaults — 30s policy / unlimited concurrency).
  const subagent6Deps: SubagentBlock["subagent6Deps"] = {
    ...(config.subagent.waitTimeoutPolicy !== undefined
      ? { waitTimeoutPolicy: config.subagent.waitTimeoutPolicy }
      : {}),
    ...(config.subagent.maxConcurrent !== undefined
      ? { maxConcurrent: config.subagent.maxConcurrent }
      : {}),
  }
  return { extraTools, taskRegistry: reg, cleanup, subagent6Deps }
}
