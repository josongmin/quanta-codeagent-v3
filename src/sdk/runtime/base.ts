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
  /** A2 — the SHARED per-session Canvas artifact registry, lifted onto the base
   *  by the composition root ONLY when `QUANTA_ARTIFACT_STORE` is on. Typed
   *  `unknown` at this SDK layer (the `@/artifact` slice is not importable here);
   *  the host-runtime `RuntimeBase` re-declares it as the concrete
   *  `ArtifactRegistry`. Two consumers: the capability manifest's `artifacts` bit
   *  and the turn runner's `artifact.ready` producer drain. Absent ⇒ both off
   *  (byte-identical default-OFF). */
  artifactRegistry?: unknown
  /** A2 — the host-side READ-ONLY `quanta-artifact://` preview resolver, minted
   *  at the composition root over the SAME shared registry when the store is on.
   *  Typed `unknown` at this SDK layer; the host-runtime `RuntimeBase` re-declares
   *  it as `ArtifactPreviewResolver`. A future IPC handler reads it off the base to
   *  serve jailed preview bytes. Absent ⇒ no preview channel (byte-identical). */
  artifactPreviewResolver?: unknown
}

export type RuntimeAgentConfigBase = Omit<AgentConfig, "modePolicy" | "budgetMeter"> &
  RuntimeAgentConfigAugments

export type RuntimeAgentTurnDeps = RuntimeAgentConfigBase

export type RuntimeAgentTurnAssembler = {
  bivarianceHack(messages: Message[], deps: RuntimeAgentTurnDeps): AgentConfig
}["bivarianceHack"]
