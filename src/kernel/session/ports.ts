import type { AgentOutcome } from "@/agent"
import type { ImageBlock, Message } from "@/llm"
import type {
  ArtifactRef,
  CapabilityManifest,
  PendingApprovalView,
  SessionEvent,
} from "@/protocol/session"

export interface KernelClock {
  now(): Date
}

export const systemClock: KernelClock = {
  now: (): Date => new Date(),
}

export interface SessionHostDescription {
  readonly sessionId: string
  readonly permissionMode: string
  readonly capabilityManifest: CapabilityManifest
  readonly identityMode?: string
  readonly toolProfile?: string
}

export interface SessionHostTurnResult {
  readonly outcome: AgentOutcome
  readonly messages: readonly Message[]
  readonly artifacts?: readonly ArtifactRef[]
  readonly approvalRequest?: PendingApprovalView
}

export type SessionHostSideConversationInheritance = "none" | "system" | "last-turn"

export interface SessionHostSideConversationArgs {
  readonly question: string
  readonly inherit?: SessionHostSideConversationInheritance
  readonly tools?: readonly string[]
  readonly maxTurns?: number
  readonly signal: AbortSignal
  readonly messages: readonly Message[]
}

export interface SessionHostSideConversationResult {
  readonly outcome: AgentOutcome
  readonly answerText: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolsAvailable: number
}

export interface SessionHost {
  describe(): SessionHostDescription
  runTurn(args: {
    readonly prompt: string
    readonly images?: readonly ImageBlock[]
    readonly signal?: AbortSignal
  }): Promise<SessionHostTurnResult>
  setIdentityMode?(mode: string): Promise<void> | void
  setToolProfile?(profile: string): Promise<void> | void
  startSideConversation?(
    args: SessionHostSideConversationArgs,
  ): Promise<SessionHostSideConversationResult>
  peekMessages?(): readonly Message[]
  peekLastOutcome?(): AgentOutcome | undefined
  replaceMessages?(messages: readonly Message[]): void
  close(): Promise<void>
}

export interface KernelEventLogPort {
  append(event: SessionEvent): Promise<void> | void
  list(): readonly SessionEvent[]
}

export interface KernelDispatchContext {
  readonly clock: KernelClock
  readonly eventLog: KernelEventLogPort
  readonly host: SessionHost
  readonly signal?: AbortSignal
}
