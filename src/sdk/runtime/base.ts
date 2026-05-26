import type { AgentConfig } from "@/agent"
import type { Message } from "@/llm"
import type { SessionDeps } from "@/runner/assemble/config"

export type RuntimeAgentTurnAssembler = (messages: Message[], deps: SessionDeps) => AgentConfig

export type RuntimeAgentConfigBase = Omit<AgentConfig, "modePolicy" | "budgetMeter"> &
  Pick<Partial<SessionDeps>, "systemSource" | "toolProfileState" | "identityModeState">
