import type {
  ArtifactRef,
  CapabilityManifest,
  PendingApprovalView,
  SessionSnapshotLite,
  SessionStateView,
} from "@/protocol/session"

export interface KernelTranscriptState {
  readonly messageCount: number
  readonly lastUserText?: string
  readonly lastAssistantText?: string
}

export interface KernelSessionState {
  readonly sessionId: string
  readonly revision: number
  readonly seq: number
  readonly status: "idle" | "running" | "awaiting_approval" | "failed" | "closed"
  readonly draftInput: string
  readonly permissionMode: string
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly pendingApproval: PendingApprovalView | null
  readonly transcript: KernelTranscriptState
  readonly artifacts: readonly ArtifactRef[]
  readonly capabilityManifest: CapabilityManifest
  readonly lastOutcomeReason?: string
}

export interface CreateKernelSessionStateInput {
  readonly sessionId: string
  readonly permissionMode: string
  readonly capabilityManifest: CapabilityManifest
  readonly identityMode?: string
  readonly toolProfile?: string
}

export const createKernelSessionState = (
  input: CreateKernelSessionStateInput,
): KernelSessionState => ({
  sessionId: input.sessionId,
  revision: 0,
  seq: 0,
  status: "idle",
  draftInput: "",
  permissionMode: input.permissionMode,
  ...(input.identityMode !== undefined ? { identityMode: input.identityMode } : {}),
  ...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
  pendingApproval: null,
  transcript: { messageCount: 0 },
  artifacts: [],
  capabilityManifest: input.capabilityManifest,
})

export const toSessionStateView = (state: KernelSessionState): SessionStateView => ({
  status: state.status,
  draftInput: state.draftInput,
  permissionMode: state.permissionMode,
  ...(state.identityMode !== undefined ? { identityMode: state.identityMode } : {}),
  ...(state.toolProfile !== undefined ? { toolProfile: state.toolProfile } : {}),
  messageCount: state.transcript.messageCount,
  ...(state.transcript.lastUserText !== undefined
    ? { lastUserText: state.transcript.lastUserText }
    : {}),
  ...(state.transcript.lastAssistantText !== undefined
    ? { lastAssistantText: state.transcript.lastAssistantText }
    : {}),
  ...(state.lastOutcomeReason !== undefined ? { lastOutcomeReason: state.lastOutcomeReason } : {}),
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
