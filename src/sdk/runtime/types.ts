import type { AgentOutcome } from "@/agent"
import type { CreateRuntimeOptions, RuntimeSessionConfig } from "@/host/runtime"
import type {
  SessionHostSideConversationArgs,
  SessionHostSideConversationResult,
} from "@/kernel/session"
import type { ImageBlock, Message } from "@/llm"
import type {
  ApprovalRespondCommand,
  ArtifactRef,
  InputAppendCommand,
  PendingApprovalView,
  SessionCommand,
  SessionEvent,
  SessionIdentitySetCommand,
  SessionSnapshotLite,
  SessionToolProfileSetCommand,
  SessionTranscriptReplaceCommand,
  TurnRunCommand,
} from "@/protocol/session"

export interface SessionDispatchOptions {
  readonly signal?: AbortSignal
}

export interface SessionDispatchResult {
  readonly revision: number
  readonly seq: number
  readonly events: readonly SessionEvent[]
  readonly transcript?: {
    readonly messages: readonly Message[]
  }
  readonly turn?: {
    readonly outcome: AgentOutcome
    readonly messages: readonly Message[]
    readonly artifacts?: readonly ArtifactRef[]
    readonly approvalRequest?: PendingApprovalView
  }
}

export type RuntimeSideConversationArgs = SessionHostSideConversationArgs
export type RuntimeSideConversationResult = SessionHostSideConversationResult

export interface RuntimeSession {
  readonly sessionId: string
  dispatch(
    command: SessionCommand,
    options?: SessionDispatchOptions,
  ): Promise<SessionDispatchResult>
  subscribe(listener: (event: SessionEvent) => void): () => void
  snapshot(): Promise<SessionSnapshotLite>
  close(): Promise<void>
  readonly input: {
    append(
      text: string,
      meta?: Partial<Omit<InputAppendCommand, "sessionId" | "type" | "text" | "images">> & {
        readonly images?: readonly ImageBlock[]
      },
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly turn: {
    run(
      meta?: Partial<Omit<TurnRunCommand, "sessionId" | "type">>,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly identity: {
    set(
      mode: string,
      meta?: Partial<Omit<SessionIdentitySetCommand, "sessionId" | "type" | "mode">>,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly toolProfile: {
    set(
      profile: string,
      meta?: Partial<Omit<SessionToolProfileSetCommand, "sessionId" | "type" | "profile">>,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly approval: {
    respond(
      approvalId: string,
      decision: "approve" | "deny",
      meta?: Partial<
        Omit<ApprovalRespondCommand, "sessionId" | "type" | "approvalId" | "decision">
      >,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly transcript: {
    replace(
      messages: readonly Message[],
      meta?: Partial<Omit<SessionTranscriptReplaceCommand, "sessionId" | "type" | "messages">>,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly side: {
    start(
      args: RuntimeSideConversationArgs,
      options?: SessionDispatchOptions,
    ): Promise<RuntimeSideConversationResult>
  }
}

export interface RuntimeFacade {
  createSession(config: RuntimeSessionConfig): Promise<RuntimeSession>
  close(): Promise<void>
}

export type { CreateRuntimeOptions, RuntimeSessionConfig }
