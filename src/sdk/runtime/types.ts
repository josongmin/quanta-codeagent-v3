import type { AgentOutcome } from "@/agent"
import type { CreateRuntimeOptions, RuntimeSessionConfig } from "@/host/runtime"
import type { ConnectedSessionTransport, SessionTransport } from "@/ipc/session"
import type { SessionHostSideConversationResult } from "@/kernel/session"
import type { ImageBlock, Message } from "@/llm"
import type {
  ApprovalRespondCommand,
  ArtifactRef,
  InputAppendCommand,
  PendingApprovalView,
  SessionCommand,
  SessionEvent,
  SessionIdentitySetCommand,
  SessionPermissionSetCommand,
  SessionSnapshotLite,
  SessionToolProfileSetCommand,
  SessionTranscriptReplaceCommand,
  TurnRunCommand,
} from "@/protocol/session"

export type { RuntimeAgentConfigBase, RuntimeAgentTurnAssembler } from "./base"

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

export interface RuntimeSideConversationArgs {
  readonly question: string
  readonly inherit?: "none" | "system" | "last-turn"
  readonly tools?: readonly string[]
  readonly maxTurns?: number
  readonly signal: AbortSignal
}
export type RuntimeSideConversationResult = SessionHostSideConversationResult

export interface RuntimeSession {
  readonly sessionId: string
  dispatch(
    command: SessionCommand,
    options?: SessionDispatchOptions,
  ): Promise<SessionDispatchResult>
  subscribe(listener: (event: SessionEvent) => void): () => void
  snapshot(): Promise<SessionSnapshotLite>
  attachSessionTransport(
    transport: SessionTransport,
    options?: { readonly replayWindow?: number },
  ): Promise<ConnectedSessionTransport>
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
  readonly permission: {
    set(
      mode: string,
      meta?: Partial<Omit<SessionPermissionSetCommand, "sessionId" | "type" | "mode">>,
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
    /** P1 Phase 0 (jul-11) — the symmetric LOSSLESS read of the live transcript.
     *  The SessionEvent archive truncates tool args/results to ~256 chars; this
     *  returns the full `Message[]` a surface needs to persist for a later live
     *  thread swap. Synchronous snapshot of the current working set. */
    messages(): readonly Message[]
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
