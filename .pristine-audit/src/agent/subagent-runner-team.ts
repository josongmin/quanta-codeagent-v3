import type { AgentConfig } from "./types"

export const maybeRegisterChildTeam = (parent: AgentConfig, childLabel: string): void => {
  const registry = parent.teamRegistry
  if (registry === undefined) return
  const team = registry.teamOf(parent.mailboxAgentId ?? "root")
  if (team === undefined) return
  try {
    registry.addMember(team, childLabel)
  } catch {
    // Team membership does not own the child execution lifecycle.
  }
}

export const maybeUnregisterChildTeam = (parent: AgentConfig, childLabel: string): void => {
  const registry = parent.teamRegistry
  if (registry === undefined) return
  const parentLabel = parent.mailboxAgentId ?? "root"
  const team = registry.teamOf(parentLabel)
  if (team === undefined) return
  try {
    registry.removeMember(team, childLabel)
  } catch {
    // bookkeeping only — never fail a teardown on a registry hiccup
  }
}
