import type { AgentConfig, AgentOutcome } from "@/agent"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { SessionHost } from "@/kernel/session"
import type { Message } from "@/llm"
import type { SessionDeps } from "@/runner/assemble"
import { runOnce } from "@/runner/orchestrate"
import type { SessionMeta } from "@/session"
import type { BuildCapabilityManifestFromSessionDeps } from "./types"

export interface LegacySessionHostOptions {
  readonly boot?: Pick<
    SessionBootstrapResult,
    "mode" | "refreshSystemPrompt" | "toolProfileState" | "identityModeState"
  >
  readonly sessionDeps: SessionDeps
  readonly assembleConfig: (messages: Message[], deps: SessionDeps) => AgentConfig
  readonly history: readonly Message[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly shutdown: () => Promise<void>
  readonly mcpClients?: Array<{ stop: () => Promise<void> }>
  readonly buildCapabilityManifest: BuildCapabilityManifestFromSessionDeps
}

export interface LegacySessionHost extends SessionHost {
  peekMessages(): readonly Message[]
  peekLastOutcome(): AgentOutcome | undefined
}

export const createLegacySessionHost = (options: LegacySessionHostOptions): LegacySessionHost => {
  let history = [...options.history]
  let lastOutcome: AgentOutcome | undefined
  let closed = false
  let shutdownComplete = false
  const capabilityManifest = options.buildCapabilityManifest(options.sessionDeps)

  const close = async (): Promise<void> => {
    if (shutdownComplete) return
    shutdownComplete = true
    await options.shutdown()
    closed = true
  }

  return {
    describe: () => ({
      sessionId: options.sessionDeps.sessionId,
      permissionMode: options.sessionDeps.permission.mode,
      capabilityManifest,
      ...(options.boot?.identityModeState !== undefined
        ? { identityMode: options.boot.identityModeState.get() }
        : {}),
      ...(options.boot?.toolProfileState !== undefined
        ? { toolProfile: options.boot.toolProfileState.get() }
        : {}),
    }),
    runTurn: async ({ prompt, signal }) => {
      if (closed) throw new Error("legacy session host is closed")
      const turnDeps =
        signal === undefined ? options.sessionDeps : { ...options.sessionDeps, signal }
      const result = await runOnce({
        deps: turnDeps,
        assembleConfig: options.assembleConfig,
        history: [...history],
        prompt,
        state: options.state,
        idMeta: options.idMeta,
        ...(options.mcpClients !== undefined ? { mcpClients: options.mcpClients } : {}),
      })
      history = [...result.messages]
      lastOutcome = result.outcome
      return { outcome: result.outcome, messages: result.messages }
    },
    setIdentityMode: async (mode) => {
      options.boot?.identityModeState?.set(mode as never)
      options.boot?.refreshSystemPrompt?.()
    },
    setToolProfile: async (profile) => {
      options.boot?.toolProfileState?.set(profile as never)
    },
    peekMessages: () => [...history],
    peekLastOutcome: () => lastOutcome,
    close,
  }
}
