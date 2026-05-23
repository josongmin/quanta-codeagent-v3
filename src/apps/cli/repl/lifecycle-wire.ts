import { FollowUpQueue } from "@/agent/follow-up-queue"
import { TaskRegistry } from "@/subagent"
import {
  createLifecyclePills,
  isLifecyclePillsEnabled,
  type LifecyclePills,
  type McpPillServer,
  readPillEnvFlags,
} from "../lifecycle-pills"

/** Lifecycle pills build-bundle for the CLI surface — pre-creates the
 *  TaskRegistry / FollowUpQueue handles the surface needs to thread through
 *  the loop AND keep references to for per-turn polling. Each handle is
 *  `undefined` when its pill is suppressed (env knob OR pills globally off);
 *  the receiver passes `undefined` through and downstream wiring stays
 *  byte-identical (`subagent`/`followUpQueue` fields omitted entirely).
 *
 *  Extracted out of `runRepl` so the host stays under biome's cognitive-
 *  complexity budget — the function is otherwise a straight-line composer of
 *  the optional handles + pills instance. */
export interface LifecycleBundle {
  pills: LifecyclePills
  taskRegistry: TaskRegistry | undefined
  followUpQueue: FollowUpQueue | undefined
}

export const buildLifecycleBundle = (): LifecycleBundle => {
  const pillsEnabled = isLifecyclePillsEnabled(process.env, process.stderr.isTTY)
  const pillFlags = readPillEnvFlags(process.env)
  // The TaskRegistry is allocated ONLY when subagent + pills are both ON.
  // The loop receives the same instance through `buildTooling` so all four
  // subagent tools share it; the CLI holds the handle for `pendingIds()`.
  const subagentEnabledForPills =
    pillsEnabled && !pillFlags.hideTasks && process.env.QUANTA_SUBAGENT !== undefined
  const taskRegistry: TaskRegistry | undefined = subagentEnabledForPills
    ? new TaskRegistry()
    : undefined
  // FollowUpQueue is allocated when pills + follow-up pill are both ON. The
  // queue is currently producer-less from the CLI; this seam is forward-
  // compatible with mid-turn user input injection (no behavior change yet).
  const followUpQueue: FollowUpQueue | undefined =
    pillsEnabled && !pillFlags.hideFollowUp ? new FollowUpQueue() : undefined
  const pills: LifecyclePills = createLifecyclePills({
    enabled: pillsEnabled,
    hideTasks: pillFlags.hideTasks,
    hideFollowUp: pillFlags.hideFollowUp,
    hideMcp: pillFlags.hideMcp,
  })
  return { pills, taskRegistry, followUpQueue }
}

/** Derive the per-server MCP pill state from the bridged tools list. The
 *  tool name prefix `mcp__<server>__<tool>` (mcp-bridge.ts) is the only
 *  surface-visible link between a tool and its server — clients are opaque
 *  (no public getter for the config name). Returns an empty servers list
 *  when no MCP tools are bridged ⇒ the pill is omitted by the renderer. */
export const deriveMcpPillServers = (
  mcpTools: ReadonlyArray<{ name: string }>,
): McpPillServer[] => {
  const perServer = new Map<string, number>()
  for (const t of mcpTools) {
    const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(t.name)
    const serverKey = m?.[1] ?? "unknown"
    perServer.set(serverKey, (perServer.get(serverKey) ?? 0) + 1)
  }
  return [...perServer.entries()].map(([name, toolCount]) => ({
    name,
    status: "connected" as const,
    toolCount,
  }))
}

/** Snapshot the CLI-owned subagent + follow-up queue handles into the
 *  lifecycle pills + flush. Pure helper extracted to keep the `turn()` and
 *  `onTurnEnd` callsites under biome's cognitive-complexity budget.
 *
 *  Reading patterns mirror the spec's data sources:
 *    - subagent: `taskRegistry.pendingIds().length` (running) +
 *      `taskRegistry.list().length` (cumulative — running + settled).
 *    - follow-up: `followUpQueue.size()` (queue depth across all threads).
 *  Either handle absent ⇒ that pill is omitted (no allocation). `flush()`
 *  is a no-op when every pill falls below its threshold, so a quiet turn
 *  leaves no trailing line. */
export const snapshotAndFlushLifecyclePills = (
  pills: LifecyclePills,
  taskRegistry: TaskRegistry | undefined,
  followUpQueue: FollowUpQueue | undefined,
): void => {
  if (taskRegistry !== undefined) {
    const running = taskRegistry.pendingIds().length
    const total = taskRegistry.list().length
    pills.update({ subagent: { running, total } })
  }
  if (followUpQueue !== undefined) {
    pills.update({ followUp: { queued: followUpQueue.size() } })
  }
  pills.flush()
}
