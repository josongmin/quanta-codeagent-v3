import type { AgentConfig } from "@/agent"
import type { RuntimeAgentTurnAssembler, RuntimeAgentTurnDeps } from "@/sdk/runtime/base"
import { assembleAgentConfig, type AssembleRequest } from "./assemble"

export type InteractiveTurnAssemblerRequest = Omit<AssembleRequest, "base" | "mode">

export const buildInteractiveTurnAssembler = (
  req: InteractiveTurnAssemblerRequest = {},
): RuntimeAgentTurnAssembler => {
  return (messages, turnDeps: RuntimeAgentTurnDeps): AgentConfig =>
    assembleAgentConfig({
      mode: "interactive",
      ...req,
      base: {
        ...turnDeps,
        messages,
      },
    })
}
