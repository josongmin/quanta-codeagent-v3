import type { ImageBlock, Message } from "@/llm"
import type {
  ArtifactRef,
  CapabilityManifest,
  PendingApprovalView,
  SessionSnapshotLite,
  SessionStateView,
} from "@/protocol/session"
import type {
  LlmContinuationObservation,
  LlmRequestObservation,
} from "@/shared/llm-route-types"
import { SingleWriterLease } from "./lease"

export interface KernelTranscriptState {
  readonly messageCount: number
  readonly lastUserText?: string
  readonly lastAssistantText?: string
  readonly streamingAssistantText?: string
}

/** Token usage carried alongside the kernel state. Mirrors
 *  `SessionHostTurnUsage` in `./ports` so the scheduler can echo it onto
 *  `turn.completed` without an upstream type pull-in. */
export interface KernelTokenUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly costMicroUsd?: number
}

export interface KernelSessionState {
  readonly sessionId: string
  readonly revision: number
  readonly seq: number
  readonly lease: SingleWriterLease
  readonly status: "idle" | "running" | "awaiting_approval" | "failed" | "closed"
  readonly messages: readonly Message[]
  readonly draftInput: string
  readonly draftImages: readonly ImageBlock[]
  readonly permissionMode: string
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly pendingApproval: PendingApprovalView | null
  readonly transcript: KernelTranscriptState
  readonly artifacts: readonly ArtifactRef[]
  readonly capabilityManifest: CapabilityManifest
  readonly lastOutcomeReason?: string
  /** Active LLM model slug — captured from the host description at session
   *  creation. Echoed on `session.created` and `turn.completed`. */
  readonly modelSlug?: string
  /** Token usage from the most recent `turn.completed`. Cumulative tally is
   *  the UI's concern; the kernel only holds the latest. */
  readonly lastTokenUsage?: KernelTokenUsage
  /** Most recent request-route observation emitted by the running/completed
   *  turn. Mirrors `turn.llm.request` so snapshot-only consumers can inspect
   *  the last effective request without replaying the event log. */
  readonly lastLlmRequest?: LlmRequestObservation & {
    readonly policy?: import("@/shared/turn-policy-types").TurnPolicySnapshot
  }
  /** Most recent Responses continuation-routing decision, if any. */
  readonly lastLlmContinuation?: LlmContinuationObservation
}

export interface CreateKernelSessionStateInput {
  readonly sessionId: string
  readonly permissionMode: string
  readonly capabilityManifest: CapabilityManifest
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly messages?: readonly Message[]
  readonly modelSlug?: string
}

const lastTextBlock = (message: Message | undefined): string | undefined => {
  if (message === undefined) return undefined
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
}

export const summarizeTranscript = (messages: readonly Message[]): KernelTranscriptState => {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  const lastUserText = lastTextBlock(lastUser)
  const lastAssistantText = lastTextBlock(lastAssistant)
  return {
    messageCount: messages.length,
    ...(lastUserText !== undefined ? { lastUserText } : {}),
    ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
  }
}

export const createKernelSessionState = (
  input: CreateKernelSessionStateInput,
): KernelSessionState => {
  const messages = [...(input.messages ?? [])]
  return {
    sessionId: input.sessionId,
    revision: 0,
    seq: 0,
    lease: new SingleWriterLease(),
    status: "idle",
    messages,
    draftInput: "",
    draftImages: [],
    permissionMode: input.permissionMode,
    ...(input.identityMode !== undefined ? { identityMode: input.identityMode } : {}),
    ...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
    pendingApproval: null,
    transcript: summarizeTranscript(messages),
    artifacts: [],
    capabilityManifest: input.capabilityManifest,
    ...(input.modelSlug !== undefined ? { modelSlug: input.modelSlug } : {}),
  }
}

export const toSessionStateView = (state: KernelSessionState): SessionStateView => ({
  status: state.status,
  draftInput: state.draftInput,
  permissionMode: state.permissionMode,
  ...(state.identityMode !== undefined ? { identityMode: state.identityMode } : {}),
  ...(state.toolProfile !== undefined ? { toolProfile: state.toolProfile } : {}),
  ...(state.modelSlug !== undefined ? { modelSlug: state.modelSlug } : {}),
  messageCount: state.transcript.messageCount,
  ...(state.transcript.lastUserText !== undefined
    ? { lastUserText: state.transcript.lastUserText }
    : {}),
  ...(state.transcript.lastAssistantText !== undefined
    ? { lastAssistantText: state.transcript.lastAssistantText }
    : {}),
  ...(state.transcript.streamingAssistantText !== undefined
    ? { streamingAssistantText: state.transcript.streamingAssistantText }
    : {}),
  ...(state.lastOutcomeReason !== undefined ? { lastOutcomeReason: state.lastOutcomeReason } : {}),
  ...(state.lastLlmRequest !== undefined ? { lastLlmRequest: state.lastLlmRequest } : {}),
  ...(state.lastLlmContinuation !== undefined
    ? { lastLlmContinuation: state.lastLlmContinuation }
    : {}),
})

export const toSessionSnapshotLite = (state: KernelSessionState): SessionSnapshotLite => ({
  sessionId: state.sessionId,
  revision: state.revision,
  seq: state.seq,
  state: toSessionStateView(state),
  capabilities: state.capabilityManifest,
  pendingApproval: state.pendingApproval,
  openArtifacts: [...state.artifacts],
})
