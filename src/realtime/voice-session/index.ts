/**
 * Realtime voice-session slice barrel (ADR-0439, RFC-03).
 *
 * Live bidirectional spoken dialog: composes the existing `@/realtime`
 * transport + `@/voice` recorder + a sibling `AudioPlaybackPort`, driven by
 * the OpenAI Realtime API (server-side VAD + codec + TTS).
 *
 * Plane-clean: this slice imports only `@/realtime` + `@/voice` + `@/shared`.
 * Zero `@/agent` / `@/tool` / `@/llm` (auth is an injected value) /
 * `@/permission` / `@/mcp`.
 *
 * Default-OFF: NOTHING in the existing tree imports `@/realtime/voice-session`.
 * Surfaces opt in by constructing the session + adapters and threading the
 * port into their own wiring (the `/voice-live` slash). Existing CLI / agent /
 * runner / tool paths are byte-identical. Pinned by HELL-RTV-11.
 *
 * Honest codec boundary: we send/receive base64 PCM16 over the existing
 * text-WS — NO opus encode/decode is performed here. The only local DSP is the
 * isolated, optional, pure WAV-strip + linear resample in `pcm-bridge.ts`.
 */

export {
  createDefaultPlayback,
  DEFAULT_PLAYBACK_BACKENDS,
  type DefaultPlaybackOpts,
  FFPLAY_BACKEND,
  PAPLAY_BACKEND,
  type PlaybackBackend,
  type PlaybackChild,
  type PlaybackSpawner,
} from "./default-playback"
export {
  createDefaultVoiceSession,
  type DefaultSessionDeps,
  type MicPump,
} from "./default-session"
export {
  createOpenAIRealtimeAdapter,
  type OpenAIRealtimeAdapterOpts,
} from "./openai-realtime-adapter"
export {
  bridgeToRealtime,
  resamplePcm16,
  stripWavHeader,
} from "./pcm-bridge"
export type {
  AudioPlaybackPort,
  PlaybackError,
} from "./playback-port"
export type {
  RealtimeVoiceSessionPort,
  ServerVadConfig,
  VoiceSessionError,
  VoiceSessionEvent,
  VoiceSessionStartOpts,
  VoiceSessionState,
  VoiceSessionUnsubscribe,
  VoiceTurnMode,
} from "./port"
export {
  buildSessionUpdate,
  DEFAULT_VOICE,
  REALTIME_PCM_RATE,
  type SessionConfigInput,
  type SessionUpdatePayload,
} from "./session-config"
export {
  type ReduceResult,
  reduce,
  type VoiceSessionAction,
} from "./state-machine"
