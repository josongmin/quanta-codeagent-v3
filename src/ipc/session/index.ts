export type {
  AttachHandshake,
  AttachHandshakeOpts,
  BuildApprovalRespondArgs,
  RunSessionHandshakeResult,
  RunSessionResumeHandshakeResult,
  SessionApprovalAnswer,
  SessionApprovalFlow,
  SessionApprovalFlowDeps,
  SessionHandshakeHandoff,
  SessionResumeHandshakeHandoff,
} from "./attach-flow"
export {
  buildApprovalRespondCommand,
  buildRespondForAnswer,
  createAttachHandshake,
  createSessionApprovalFlow,
  HANDSHAKE_DISCOVERY_SESSION_ID,
  runSessionHandshake,
  runSessionResumeHandshake,
} from "./attach-flow"
export type {
  ConnectedSessionTransport,
  CreateSessionTransportBridgeOpts,
  SessionTransportBridge,
  SessionTransportBridgeErrorArgs,
} from "./bridge"
export { createSessionTransportBridge, planSessionReplay } from "./bridge"
export {
  HEARTBEAT_INTERVAL_MS,
  replyToHeartbeat,
  replyToHeartbeatOnTransport,
} from "./heartbeat"
export type {
  CreateSessionTransportClientOpts,
  SessionTransportClient,
  SessionTransportClientRejection,
  SessionTransportConnectionClosed,
  SessionTransportConnectionConnected,
  SessionTransportConnectionResume,
  SessionTransportConnectionState,
} from "./client"
export { createSessionTransportClient } from "./client"
export type { InboundSessionFrameResolution } from "./codec"
export {
  decodeSessionTransportMessage,
  encodeSessionTransportMessage,
  resolveInboundSessionTransportFrame,
  tryDecodeSessionTransportMessage,
} from "./codec"
export {
  SessionDispatchFailedError,
  SessionDuplicateCommandError,
  typedErrorFromRejectedMessage,
} from "./errors"
export type {
  CreateSessionHandleOpts,
  SessionHandle,
  SessionHandleSnapshot,
  SessionTurnCorrelationLossReason,
  SessionTurnEndEvent,
  TurnEndCorrelator,
} from "./handle"
export {
  createSessionHandle,
  createTurnEndCorrelator,
  SessionHandleClosedError,
  SessionTurnCorrelationLostError,
} from "./handle"
export type { BindSessionTransportServerOpts, SessionTransportServer } from "./server"
export { bindSessionTransportServer } from "./server"
export { type CreateSessionStdioClientOpts, createSessionStdioClient } from "./stdio-client"
export { type CreateSessionStdioServerOpts, createSessionStdioServer } from "./stdio-server"
export {
  type CreateSessionStdioTransportOpts,
  createSessionStdioTransport,
  type StdioReader,
  type StdioWriter,
} from "./transports/stdio"
export {
  type CreateSessionStdioSpawnTransportOpts,
  createSessionStdioSpawnTransport,
  type SessionStdioSpawnTransport,
} from "./transports/stdio-spawn"
export {
  type SessionWebSocketLike,
  wrapWebSocketLikeAsSessionTransport,
} from "./transports/websocket"
export type {
  SessionDurableEventLogReader,
  SessionReplayPlan,
  SessionTransport,
  SessionTransportCloseInfo,
  SessionTransportConnectMessage,
  SessionTransportHandler,
  SessionTransportHeartbeatMessage,
  SessionTransportMessage,
  SessionTransportRejectedMessage,
  SessionTransportRejectReason,
  SessionTransportRejectTarget,
  SessionTransportResumedMessage,
} from "./types"
export {
  type CreateSessionWebSocketClientOpts,
  createSessionWebSocketClient,
} from "./websocket-client"
export {
  type CreateSessionWebSocketServerOpts,
  createSessionWebSocketServer,
} from "./websocket-server"
