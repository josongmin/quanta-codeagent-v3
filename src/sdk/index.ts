/**
 * `quanta-codeagent/sdk` — the ONE public door for embedding quanta's agent
 * loop in-process (jul-4 SDK embed DX plan).
 *
 * Consumers import ONLY from here. Nothing under `src/sdk/**` may import
 * `@/apps/cli`, `@/apps/bench`, or `@/apps/agent` (enforced by
 * `tests/unit/sdk/boundary.slice.test.ts`), and the export set below is the
 * pinned public surface (audit C: no 133-field `AgentConfig` leak).
 */

export type {
  SessionTransport,
  SessionTransportClientRejection,
  SessionTransportCloseInfo,
  SessionTransportConnectionState,
  SessionTransportMessage,
} from "@/ipc/session"
// ── Wire door: session.v1 typed errors (jul-16 ticket 01 S7) ──
export {
  SessionDispatchFailedError,
  SessionDuplicateCommandError,
  type SessionHandle,
  SessionHandleClosedError,
  type SessionHandleSnapshot,
  type SessionTurnCorrelationLossReason,
  SessionTurnCorrelationLostError,
  type SessionTurnEndEvent,
} from "@/ipc/session"
// ── Public-signature closure (jul-16 audit F4): types the surface REFERENCES
// must be NAMEABLE by consumers — `onCommandRejected`'s rejection payload and
// `input.append`'s image block (both type-only; the value surface is pinned
// unchanged by tests/unit/sdk/public-surface.test.ts). ──
export type { ImageBlock } from "@/llm"
// ── Wire door: session.v1 protocol (types + codec + version) ──
export type {
  ApprovalRespondCommand,
  ArtifactRef,
  CapabilityManifest,
  CommandReceipt,
  InputAppendCommand,
  PendingApprovalView,
  SessionCommand,
  SessionEvent,
  SessionEventType,
  SessionSnapshotLite,
  SessionStateView,
  SessionVerbSurface,
  TurnCancelCommand,
  TurnRunCommand,
} from "@/protocol/session"
export {
  decodeSessionCommand,
  decodeSessionEvent,
  decodeSessionSnapshot,
  encodeSessionCommand,
  encodeSessionEvent,
  encodeSessionSnapshot,
  SESSION_PROTOCOL_VERSION,
  SessionClosedError,
  SessionProtocolError,
  SessionProtocolValidationError,
  SessionProtocolVersionError,
  SessionRevisionConflictError,
} from "@/protocol/session"
// ── Approval decision SSOT (the `onApproval` contract type) ──
export type { ApprovalDecisionResult } from "@/runner/orchestrate"
// ── Tool authoring (Phase 5 re-export) ──
export { defineTool } from "@/tool"
export { defineToolAsync } from "@/tool/async-helper"
// ── Wire door: connect() + transports (jul-16 ticket 01 S2c) ──
export {
  type ConnectOptions,
  type ConnectWebSocket,
  type ConnectWebSocketCtor,
  connect,
  type SessionTransportSpec,
  type StdioTransportOptions,
  transports,
  type WsTransportOptions,
} from "./connect"
// ── Façade ──
export { type AnalysisAgent, type AnalysisAgentOptions, createAnalysisAgent } from "./embed"
// ── Errors ──
export { NoCredentialError, ToolRegistrationError } from "./errors"
// ── Event narrowing ──
export { isDone, isError, isText, isThinking, isToolCall, isToolResult, isUsage } from "./events"
export { type AnalysisProfile, DEFAULT_PROFILE } from "./profiles"
export { type AgentRun, DEFAULT_EVENT_BUFFER, type RunHooks } from "./run"
// ── Test harness (Phase 6) ──
export { type FakeCompletion, fakeLlm, RecordingStream } from "./testing"
// ── Curated types ──
export type {
  AgentEvent,
  AgentOutcome,
  LLMPort,
  Message,
  StopReason,
  Tool,
  ToolContext,
  ToolEvent,
} from "./types"

// ── Version ──
export { version } from "./version"
