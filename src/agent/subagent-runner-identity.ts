import { type AgentMetaRegistry, assignNickname } from "@/subagent"
import type { AgentConfig } from "./types"

export interface SharedChildIdentityState {
  readonly nextOrdinalByParent: Map<string, number>
  nextSpawnSeq: number
}

export interface ChildLocalIdentityState {
  childOrdinal: number
  spawnSeq: number
}

export interface ChildMailboxIds {
  agentId: string
  parentId: string
  spawnSeq: number
}

const sharedChildIdentityStates = new WeakMap<object, SharedChildIdentityState>()

const childIdentityAnchor = (parent: AgentConfig): object | undefined => {
  const candidate =
    parent.subagentTurnWake ??
    parent.teamRegistry ??
    parent.subagentMailbox ??
    parent.subagentAgentMeta ??
    parent.subagent?.taskRegistry
  return typeof candidate === "object" && candidate !== null ? candidate : undefined
}

export const childIdentityState = (parent: AgentConfig): SharedChildIdentityState | undefined => {
  const anchor = childIdentityAnchor(parent)
  if (anchor === undefined) return undefined
  const existing = sharedChildIdentityStates.get(anchor)
  if (existing !== undefined) return existing
  const created: SharedChildIdentityState = { nextOrdinalByParent: new Map(), nextSpawnSeq: 0 }
  sharedChildIdentityStates.set(anchor, created)
  return created
}

export const allocateChildMailboxIds = (
  parentLabel: string,
  shared: SharedChildIdentityState | undefined,
  local: ChildLocalIdentityState,
): ChildMailboxIds => {
  if (shared !== undefined) {
    const ordinal = shared.nextOrdinalByParent.get(parentLabel) ?? 0
    shared.nextOrdinalByParent.set(parentLabel, ordinal + 1)
    const spawnSeq = shared.nextSpawnSeq
    shared.nextSpawnSeq += 1
    return { agentId: `${parentLabel}/${ordinal}`, parentId: parentLabel, spawnSeq }
  }
  const ordinal = local.childOrdinal
  local.childOrdinal += 1
  const spawnSeq = local.spawnSeq
  local.spawnSeq += 1
  return { agentId: `${parentLabel}/${ordinal}`, parentId: parentLabel, spawnSeq }
}

export const buildSubagentRunId = (
  depth: number,
  mailboxAgentId: string,
  spawnSeq: number,
  now: () => number,
): string => {
  const safeMailboxId = mailboxAgentId.replace(/[^A-Za-z0-9_-]/g, "_")
  return `sub-d${depth}-${safeMailboxId}-${now().toString(36)}-${spawnSeq.toString(36)}`
}

export const recordChildNickname = (
  agentMeta: AgentMetaRegistry | undefined,
  taskId: string | undefined,
  mailboxAgentId: string,
  depth: number,
  agentType: string | undefined,
): void => {
  if (agentMeta === undefined || taskId === undefined || taskId.length === 0) return
  const nickname = assignNickname(mailboxAgentId)
  const label = agentType !== undefined && agentType.length > 0 ? agentType : nickname
  agentMeta.set(taskId, { depth, label })
}
