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
  /** Track A2 — composition-root named-permission-profile wire. When the
   *  operator selects a profile via `QUANTA_PERMISSION_PROFILE` / the
   *  `--permission-profile <name>` flag, the composition root constructs a
   *  `TwoLayerManager`, applies the resolved profile via
   *  `setPermissionProfileByName(threadId, name)`, and publishes the manager
   *  here so a future loop consumer can read the per-thread layered policy.
   *  Absent ⇒ slot omitted (byte-identical legacy). */
  permissionProfileManager?: unknown
}

export type RuntimeAgentConfigBase = Omit<AgentConfig, "modePolicy" | "budgetMeter"> &
  RuntimeAgentConfigAugments

export type RuntimeAgentTurnDeps = RuntimeAgentConfigBase

export type RuntimeAgentTurnAssembler = {
  bivarianceHack(messages: Message[], deps: RuntimeAgentTurnDeps): AgentConfig
}["bivarianceHack"]
