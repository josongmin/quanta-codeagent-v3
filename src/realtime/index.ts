/**
 * Realtime slice barrel (ADR-0230).
 *
 * Codex absorption — bidirectional WebSocket port + Bun-native adapter +
 * deterministic headless stub + SDP/codec helpers. 8-method surface
 * mirroring Codex Desktop's realtime API.
 *
 * Plane-clean: only `@/shared` is imported by this slice's dependencies.
 * Zero @/agent / @/tool / @/llm / @/mcp / @/permission / @/media / @/voice.
 *
 * Default-OFF: nothing in the existing tree imports `@/realtime`. Surfaces
 * opt in by constructing one of the adapters and threading the port into
 * their own wiring. Existing CLI / agent / runner / tool paths are
 * byte-identical.
 */

export {
  DEFAULT_CODEC_PREFERENCE,
  negotiateCodec,
  wrapAudioChunk,
} from "./audio-codec"
export {
  type BunAdapterOpts,
  createBunWebSocketAdapter,
  type WebSocketCtor,
  type WebSocketLike,
} from "./default-adapter"
export {
  createHeadlessStub,
  type HeadlessStubHandle,
  type HeadlessStubOpts,
  type StubOutbound,
} from "./headless-stub"
export type {
  RealtimeMessageHandler,
  RealtimePort,
  RealtimeUnsubscribe,
} from "./port"
export { negotiateSdp } from "./sdp-negotiator"
export type {
  AudioCodec,
  RealtimeConnectOpts,
  RealtimeError,
  RealtimeFrame,
  RealtimeInboundMessage,
  RealtimeOutboundSignal,
  RealtimeStatus,
  SdpAnswer,
} from "./types"
