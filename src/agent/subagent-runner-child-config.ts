import type { Message } from "@/llm"
import { runtimeConfig } from "@/shared"
import type { SubagentTurnGate } from "@/subagent"
import { type Tool, ToolRegistry } from "@/tool"
import type { SubagentRequest } from "../subagent/types"
import {
  buildLeaderDecide,
  buildLeaderHitlBroker,
  type LeaderEscalationDecider,
} from "./coordination-broker-wire"
import { isMutatingMode } from "./mode"
import type { NamedAgentDefinition, NamedAgentResolver } from "./named-agent-registry"
import { buildOwnershipPolicy } from "./ownership-policy"
import type { AgentMode } from "./prompt"
import { childDepthOf } from "./spawn-depth"
import { resolveChildEffort, resolveChildLlm } from "./subagent-runner-overrides"
import { namespaceRegistry, type ToolNamespaceStrategy } from "./subagent-tool-namespace"
import type { AgentConfig } from "./types"

type MailboxIds = { agentId: string; parentId: string }

const filterRegistry = (
  parent: ToolRegistry,
  toolFilter: string[] | undefined,
  extraTools?: readonly Tool[],
): ToolRegistry => {
  const extra = extraTools ?? []
  const allTools = (): Tool[] =>
    parent
      .specs()
      .map((s) => parent.get(s.name))
      .filter((t): t is Tool => t !== undefined)
  if (!toolFilter) return extra.length === 0 ? parent : new ToolRegistry([...allTools(), ...extra])
  const allow = new Set(toolFilter)
  const kept = parent
    .specs()
    .map((s) => s.name)
    .filter((name) => allow.has(name))
    .map((name) => parent.get(name))
    .filter((t): t is NonNullable<typeof t> => t !== undefined)
  return new ToolRegistry([...kept, ...extra])
}

const chainedSignal = (parent: AbortSignal, extra?: AbortSignal): AbortSignal =>
  extra ? AbortSignal.any([parent, extra]) : parent

const buildSeedPrompt = (req: SubagentRequest): string => {
  const parts = [
    req.priorAttempt && req.priorAttempt.length > 0
      ? `## Previous attempt's findings\n${req.priorAttempt}\n\n## Current task\n${req.prompt}`
      : req.prompt,
  ]
  if (req.ownedSurfaces && req.ownedSurfaces.length > 0) {
    parts.push(
      `**Owned surfaces** (you may read/modify these): ${req.ownedSurfaces.map((s) => `- ${s}`).join("\n")}`,
    )
  }
  if (req.forbiddenSurfaces && req.forbiddenSurfaces.length > 0) {
    parts.push(
      `**Forbidden surfaces** (do NOT touch): ${req.forbiddenSurfaces.map((s) => `- ${s}`).join("\n")}`,
    )
  }
  if (req.checkpointPath && req.checkpointPath.length > 0) {
    parts.push(
      `**Checkpoint**: Write your interim progress to \`${req.checkpointPath}\` every few turns (use the \`write\` or \`edit\` tool). The parent uses this file to monitor and to recover work if you are stopped.`,
    )
  }
  if (req.resultShape && req.resultShape.length > 0)
    parts.push(`**Final answer format**: ${req.resultShape}`)
  return parts.join("\n\n")
}

const applyNamedAgent = (parent: AgentConfig, req: SubagentRequest): SubagentRequest => {
  const resolver = (parent as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver
  if (resolver === undefined || req.agentType === undefined || req.agentType.length === 0)
    return req
  const def: NamedAgentDefinition | undefined = resolver.resolve(req.agentType)
  if (def === undefined) return req
  return {
    ...req,
    ...(req.system === undefined ? { system: def.system } : {}),
    ...(req.toolFilter === undefined && def.tools !== undefined ? { toolFilter: def.tools } : {}),
    ...(req.model === undefined && def.model !== undefined ? { model: def.model } : {}),
    ...(req.mode === undefined && def.mode !== undefined ? { mode: def.mode } : {}),
  }
}

const resolveChildMode = (
  parent: AgentConfig,
  req: SubagentRequest,
): Pick<AgentConfig, "mode"> | Record<string, never> => {
  const parentMode = parent.mode
  if (req.mode === undefined || req.mode.length === 0)
    return parentMode === undefined ? {} : { mode: parentMode }
  const requested = req.mode as AgentMode
  return parentMode !== undefined && !isMutatingMode(parentMode) && isMutatingMode(requested)
    ? { mode: parentMode }
    : { mode: requested }
}

const maybeWireCoordinationBroker = (
  parent: AgentConfig,
  mailboxIds: MailboxIds,
): Pick<AgentConfig, "admissibility"> | Record<string, never> => {
  if (!runtimeConfig().teamBroker || parent.onConfirm === undefined) return {}
  const { agentId: workerId, parentId: leaderId } = mailboxIds
  if (workerId.length === 0 || leaderId.length === 0) return {}
  const leaderDecide: LeaderEscalationDecider = buildLeaderDecide(parent.onConfirm, { workerId })
  let esc = 0
  const broker = buildLeaderHitlBroker({
    workerId,
    leaderId,
    leaderDecide,
    ...(parent.subagentMailbox ? { mailbox: parent.subagentMailbox } : {}),
    nextCorrelationId: () => `${workerId}#esc${esc++}`,
  })
  return { admissibility: { coordinationBroker: broker } }
}

type ChildBase = Pick<
  AgentConfig,
  | "llm"
  | "registry"
  | "stream"
  | "permission"
  | "messages"
  | "system"
  | "cwd"
  | "maxTurns"
  | "signal"
> &
  Partial<Pick<AgentConfig, "toolAllowlist" | "ownershipPolicy">>

const buildChildBase = (
  parent: AgentConfig,
  req: SubagentRequest,
  cwd: string,
  mailboxId: string,
  toolNamespace: ToolNamespaceStrategy | undefined,
): ChildBase => {
  const filtered = filterRegistry(parent.registry, req.toolFilter, req.extraTools)
  const registry =
    toolNamespace === undefined ? filtered : namespaceRegistry(filtered, toolNamespace, mailboxId)
  const ownershipPolicy = buildOwnershipPolicy({
    ...(req.ownedSurfaces ? { owned: req.ownedSurfaces } : {}),
    ...(req.forbiddenSurfaces ? { forbidden: req.forbiddenSurfaces } : {}),
    cwd,
    enforced: runtimeConfig().fsOwnershipEnforce,
  })
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: buildSeedPrompt(req) }] },
  ]
  return {
    llm: resolveChildLlm(parent, req),
    registry,
    ...(req.toolFilter !== undefined ? { toolAllowlist: req.toolFilter } : {}),
    stream: parent.stream,
    permission: parent.permission,
    messages,
    system: req.system !== undefined && req.system.length > 0 ? req.system : parent.system,
    cwd,
    ...(ownershipPolicy !== undefined ? { ownershipPolicy } : {}),
    maxTurns: req.budget?.maxTurns ?? parent.maxTurns,
    signal: chainedSignal(parent.signal, req.signal),
  }
}

const buildChildInheritedConfig = (
  parent: AgentConfig,
  req: SubagentRequest,
  mailboxIds: MailboxIds,
  turnGate: SubagentTurnGate | undefined,
  spawnedAsTaskId: string | undefined,
): Partial<AgentConfig> => {
  const childEffort = resolveChildEffort(req)
  return {
    ...({ depth: childDepthOf(parent) } as { depth: number }),
    mailboxAgentId: mailboxIds.agentId,
    mailboxParentId: mailboxIds.parentId,
    ...(req.taskId !== undefined ? { subagentTaskId: req.taskId } : {}),
    ...(spawnedAsTaskId !== undefined ? { spawnedAsTaskId } : {}),
    ...(parent.subagentMailbox ? { subagentMailbox: parent.subagentMailbox } : {}),
    ...(parent.teamRegistry ? { teamRegistry: parent.teamRegistry } : {}),
    ...(parent.peerInbox ? { peerInbox: parent.peerInbox } : {}),
    ...(turnGate !== undefined ? { subagentTurnGate: turnGate } : {}),
    ...(childEffort !== undefined ? { sessionEffort: childEffort } : {}),
    ...(parent.onConfirm ? { onConfirm: parent.onConfirm } : {}),
    ...(parent.embedder ? { embedder: parent.embedder } : {}),
    ...(parent.compaction ? { compaction: parent.compaction } : {}),
    ...(parent.planMode !== undefined ? { planMode: parent.planMode } : {}),
    ...resolveChildMode(parent, req),
    ...(parent.verifyGuard !== undefined ? { verifyGuard: parent.verifyGuard } : {}),
    ...(parent.closeoutGuard !== undefined ? { closeoutGuard: parent.closeoutGuard } : {}),
    ...(parent.hitl !== undefined ? { hitl: parent.hitl } : {}),
    ...(parent.subagent ? { subagent: parent.subagent } : {}),
    ...maybeWireCoordinationBroker(parent, mailboxIds),
  }
}

/** Assemble the child-only config; intentionally omits parent durable state. */
export const buildChildConfig = (
  parent: AgentConfig,
  rawReq: SubagentRequest,
  cwd: string,
  mailboxIds: MailboxIds,
  toolNamespace?: ToolNamespaceStrategy,
  turnGate?: SubagentTurnGate,
  spawnedAsTaskId?: string,
): AgentConfig => {
  const req = applyNamedAgent(parent, rawReq)
  return {
    ...buildChildBase(parent, req, cwd, mailboxIds.agentId, toolNamespace),
    ...buildChildInheritedConfig(parent, req, mailboxIds, turnGate, spawnedAsTaskId),
  } as AgentConfig
}
