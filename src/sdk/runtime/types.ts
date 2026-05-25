import type { CreateRuntimeOptions, RuntimeSessionConfig } from "@/host/runtime"
import type { Message } from "@/llm"
import type {
  ApprovalRespondCommand,
  ArtifactRef,
  InputAppendCommand,
  SessionCommand,
  SessionEvent,
  SessionIdentitySetCommand,
  SessionSnapshotLite,
  SessionToolProfileSetCommand,
  TurnRunCommand,
} from "@/protocol/session"

export interface SessionDispatchOptions {
  readonly signal?: AbortSignal
}

export interface SessionDispatchResult {
  readonly revision: number
  readonly seq: number
  readonly events: readonly SessionEvent[]
}

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
      meta?: Omit<InputAppendCommand, "sessionId" | "type" | "text">,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly turn: {
    run(
      meta?: Omit<TurnRunCommand, "sessionId" | "type">,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly identity: {
    set(
      mode: string,
      meta?: Omit<SessionIdentitySetCommand, "sessionId" | "type" | "mode">,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly toolProfile: {
    set(
      profile: string,
      meta?: Omit<SessionToolProfileSetCommand, "sessionId" | "type" | "profile">,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
  readonly approval: {
    respond(
      approvalId: string,
      decision: "approve" | "deny",
      meta?: Omit<ApprovalRespondCommand, "sessionId" | "type" | "approvalId" | "decision">,
      options?: SessionDispatchOptions,
    ): Promise<SessionDispatchResult>
  }
}

export interface RuntimeFacade {
  createSession(config: RuntimeSessionConfig): Promise<RuntimeSession>
  close(): Promise<void>
}

export interface SessionExecutionView {
  readonly messages: readonly Message[]
  readonly outcomeReason?: string
  readonly artifacts: readonly ArtifactRef[]
}

export interface RuntimeSessionInternal extends RuntimeSession {
  __unsafePeekExecutionView(): SessionExecutionView
}

export type { CreateRuntimeOptions, RuntimeSessionConfig }
