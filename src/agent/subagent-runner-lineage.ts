import { projectToSubagentObservation } from "@/protocol/subagent"
import type { SubagentLifecycleEvent, TaskRegistry } from "@/subagent"
import type { SubagentRequest, SubagentResult } from "../subagent/types"
import type { AgentConfig } from "./types"

export interface LineageTaskHandle {
  registry: TaskRegistry
  taskId: string
  settle: (result: SubagentResult) => void
}

export const installSubagentEmitter = (parent: AgentConfig): void => {
  const sink = parent.onSubagentEvent
  const registry = parent.subagent?.taskRegistry
  if (sink === undefined || registry === undefined) return
  registry.setEmitter((event: SubagentLifecycleEvent) => {
    const obs = projectToSubagentObservation(
      event as Parameters<typeof projectToSubagentObservation>[0],
    )
    if (obs !== null) sink(obs)
  })
}

export const ensureLineageTask = (
  parent: AgentConfig,
  req: SubagentRequest,
  childDepth: number,
  mailboxLabel: string,
): LineageTaskHandle | undefined => {
  const registry = parent.subagent?.taskRegistry
  if (registry === undefined) return undefined
  const parentTaskId = parent.spawnedAsTaskId
  const description = req.prompt.slice(0, 120)
  if (req.taskId !== undefined) {
    const existing = registry.get(req.taskId)
    if (existing !== undefined) {
      const stamped = existing as {
        parentTaskId?: string
        depth: number
        mailboxLabel?: string
      }
      if (parentTaskId !== undefined) stamped.parentTaskId = parentTaskId
      stamped.depth = childDepth
      stamped.mailboxLabel = mailboxLabel
      registry.restampSpawn(req.taskId)
    }
    return { registry, taskId: req.taskId, settle: () => {} }
  }
  if (parent.onSubagentEvent === undefined) return undefined
  const taskId = registry.newId()
  registry.register({
    id: taskId,
    description,
    ...(req.agentType !== undefined ? { agentType: req.agentType } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    depth: childDepth,
    mailboxLabel,
  })
  return {
    registry,
    taskId,
    settle: (result: SubagentResult): void => registry.complete(taskId, result),
  }
}
