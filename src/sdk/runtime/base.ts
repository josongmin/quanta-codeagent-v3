import type { AgentConfig } from "@/agent"
import type { Message } from "@/llm"

export interface RuntimeAgentConfigAugments {
  systemSource?: unknown
  followUpQueue?: unknown
  planStore?: unknown
  retrievalStack?: unknown
  searchPipeline?: unknown
  memoryConsolidator?: unknown
  sessionCtx?: unknown
  delegation?: unknown
  subagentBackground?: unknown
  autoBackground?: unknown
  fork?: unknown
  forkSession?: unknown
  conversationCheckpoint?: unknown
  stage1OutputsStore?: unknown
  automationEngine?: unknown
  admissibility?: unknown
  planExitPort?: unknown
  userInputPort?: unknown
  toolProfileState?: unknown
  identityModeState?: unknown
  focusChain?: unknown
  shellSnapshot?: unknown
  sessionEffort?: unknown
  decisionEmitter?: unknown
  granularRegistry?: unknown
}

export type RuntimeAgentConfigBase = Omit<AgentConfig, "modePolicy" | "budgetMeter"> &
  RuntimeAgentConfigAugments

export type RuntimeAgentTurnDeps = RuntimeAgentConfigBase

export type RuntimeAgentTurnAssembler = {
  bivarianceHack(messages: Message[], deps: RuntimeAgentTurnDeps): AgentConfig
}["bivarianceHack"]
