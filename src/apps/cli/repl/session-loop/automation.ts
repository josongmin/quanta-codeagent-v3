import type { AgentConfig } from "@/agent"

/**
 * Project a REPL-owned automation slot onto the turn config without its ticker
 * handler. The REPL is the sole interval owner; the agent path receives only
 * the engine needed to expose automation tools.
 */
export const stripAutomationTickerHandler = (
  slot: NonNullable<AgentConfig["automationEngine"]> | undefined,
): NonNullable<AgentConfig["automationEngine"]> | undefined => {
  if (slot === undefined) return undefined
  const { handler: _replOwnedHandler, ...engineOnly } = slot
  return engineOnly
}
