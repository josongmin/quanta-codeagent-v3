import type { GranularRegistryPort } from "@/agent/checkpoint/granular-registry"
import type { FocusChainPort } from "@/agent/focus-chain"
import type { RuntimeFacade } from "@/sdk/runtime"
import {
  type CreateRuntimeFacadeFromSessionDepsArgs,
  createRuntimeFacadeFromSessionDeps,
  type RuntimeSessionDeps,
} from "@/sdk/runtime/bridge"
import { automationUpdateTool, type Tool, ToolRegistry } from "@/tool"

export interface CliRuntimeBridge {
  createRuntimeFacade(
    args: Omit<CreateRuntimeFacadeFromSessionDepsArgs, "sessionDeps">,
  ): Promise<RuntimeFacade>
  getRegistry(): RuntimeSessionDeps["registry"]
  wrapRegistry(mapper: (tool: Tool) => Tool): void
  getAutomationEngine(): RuntimeSessionDeps["automationEngine"]
  ensureAutomationEngine(
    slot: NonNullable<RuntimeSessionDeps["automationEngine"]>,
  ): RuntimeSessionDeps["automationEngine"]
  setGranularRegistry(registry: GranularRegistryPort): void
  getToolProfileState(): RuntimeSessionDeps["toolProfileState"]
  getIdentityModeState(): RuntimeSessionDeps["identityModeState"]
  getFocusChain():
    | { readonly tracker: FocusChainPort; readonly reinjectEveryN?: number }
    | undefined
  getDecisionEmitter(): RuntimeSessionDeps["decisionEmitter"]
  getPermissionMode(): RuntimeSessionDeps["permission"]["mode"]
  getAdmissibility(): RuntimeSessionDeps["admissibility"]
  getPlanExitPort(): RuntimeSessionDeps["planExitPort"]
  getUserInputPort(): RuntimeSessionDeps["userInputPort"]
}

export const createCliRuntimeBridge = (initial: RuntimeSessionDeps): CliRuntimeBridge => {
  let current = initial

  return {
    createRuntimeFacade: async (args) =>
      await createRuntimeFacadeFromSessionDeps({
        ...args,
        sessionDeps: current,
      }),
    getRegistry: () => current.registry,
    wrapRegistry: (mapper) => {
      current = {
        ...current,
        registry: new ToolRegistry(current.registry.all().map((tool) => mapper(tool))),
      }
    },
    getAutomationEngine: () => current.automationEngine,
    ensureAutomationEngine: (slot) => {
      current = {
        ...current,
        automationEngine: slot,
        registry: current.registry.has("automation_update")
          ? current.registry
          : new ToolRegistry([...current.registry.all(), automationUpdateTool(slot.engine)]),
      }
      return current.automationEngine
    },
    setGranularRegistry: (registry) => {
      current = { ...current, granularRegistry: registry }
    },
    getToolProfileState: () => current.toolProfileState,
    getIdentityModeState: () => current.identityModeState,
    getFocusChain: () => current.focusChain,
    getDecisionEmitter: () => current.decisionEmitter,
    getPermissionMode: () => current.permission.mode,
    getAdmissibility: () => current.admissibility,
    getPlanExitPort: () => current.planExitPort,
    getUserInputPort: () => current.userInputPort,
  }
}
