/**
 * Realtime voice-session slice — `RealtimeVoiceSessionPort` (ADR-0442, RFC-03).
 *
 * A closed-port that COMPOSES the two existing realtime/voice slices into a
 * live spoken dialog driven by the OpenAI Realtime API (server-side
 * VAD + codec + TTS). It owns the 5-state session machine; it does NOT
 * re-implement transport (delegates to `@/realtime`'s `RealtimePort`) or mic
 * capture (delegates to `@/voice`'s `AudioRecorderPort`) or playback
 * (delegates to the sibling `AudioPlaybackPort`).
 *
 * Plane-clean: imports only `@/realtime` (transport) + `@/voice` (recorder) +
 * `@/shared`. Zero `@/agent` / `@/tool` / `@/llm` (auth is passed IN as a
 * resolved bearer value by the surface) / `@/permission` / `@/mcp`. Realtime
 * voice is an I/O channel, not a tool, not a permission, not an LLM call.
 *
 * Contract:
 *   - NO-THROW: every method returns `Result<…>` for operational failures.
 *     Illegal state transitions are encoded as `Err` (HELL-RTV-02).
 *   - 5-state machine (`idle → connecting → listening → responding → closed`)
 *     queryable via `state()`. The reducer is pure (state-machine.ts).
 *   - Default-OFF: NOTHING in the existing tree imports
 *     `@/realtime/voice-session`. Pinned by HELL-RTV-11.
 *
 * Honest codec boundary: we send/receive base64 PCM16 over the existing
 * text-WS `send`/`onMessage` — the Realtime API is a text-WS-of-base64, NOT a
 * binary media WS, so NO opus/PCM transcoding is done on our side. The only
 * local DSP is an isolated, optional, pure WAV-header-strip + linear resample
 * (pcm-bridge.ts) — that is sample-rate conversion, not a codec.
 */

import type { Result } from "@/shared"

/** 5-state session machine (RFC §3.2). */
export type VoiceSessionState = "idle" | "connecting" | "listening" | "responding" | "closed"

/** Turn-detection mode (RFC §3.3). `server_vad` is the conversational
 *  default (the API detects end-of-turn from silence and auto-creates a
 *  response). `push_to_talk` disables server turn detection — the surface
 *  marks end-of-utterance explicitly via `commitTurn()`. */
export type VoiceTurnMode = "server_vad" | "push_to_talk"

/** Server-VAD knobs — passed THROUGH from config to the `session.update`
 *  payload. We invent NO tuned numbers; when a field is omitted the Realtime
 *  API applies its own documented default (RFC §3.3, no-heuristics rule). */
export interface ServerVadConfig {
  readonly threshold?: number
  readonly prefixPaddingMs?: number
  readonly silenceDurationMs?: number
}

/** Options for `start()`. `auth` is a RESOLVED bearer (the slice never reaches
 *  into `@/llm`); the surface resolves it via the existing factory/oauth seam
 *  and passes it down (RFC §4.1). */
export interface VoiceSessionStartOpts {
  /** WS endpoint, e.g. `wss://api.openai.com/v1/realtime?model=gpt-realtime`. */
  readonly endpoint: string
  /** Resolved bearer (OPENAI_API_KEY or ChatGPT OAuth access token). */
  readonly auth: string
  /** Realtime model id (NOT hardcoded — from config). */
  readonly model: string
  /** Turn-detection mode. Defaults to `server_vad`. */
  readonly mode?: VoiceTurnMode
  /** Output voice (ListVoices / config). Defaults to `"alloy"`. */
  readonly voice?: string
  /** Optional system instructions slice. */
  readonly instructions?: string
  /** Server-VAD knobs (only used when mode=server_vad). */
  readonly vad?: ServerVadConfig
  /** Aborts the connect handshake (threaded into transport.connect). */
  readonly signal?: AbortSignal
}

/** Events surfaced to `onEvent` subscribers (RFC §3.4 down-channel). */
export type VoiceSessionEvent =
  /** State machine transition. */
  | { readonly kind: "state"; readonly state: VoiceSessionState; readonly at: number }
  /** Incremental transcript text (always-on channel — works headless). */
  | { readonly kind: "transcript-delta"; readonly text: string; readonly at: number }
  /** Transcript final for the current item. */
  | { readonly kind: "transcript-done"; readonly text: string; readonly at: number }
  /** Incremental output audio (PCM16 bytes) — routed to playback. */
  | { readonly kind: "audio-delta"; readonly pcm: Uint8Array; readonly at: number }
  /** Typed session error; the surface degrades per RFC §6. */
  | { readonly kind: "error"; readonly error: VoiceSessionError; readonly at: number }

/** Subscriber teardown. Calling twice is a no-op. */
export type VoiceSessionUnsubscribe = () => void

/** Realtime voice errors — closed-union; surfaces branch on `kind`. */
export type VoiceSessionError =
  | { readonly kind: "auth-failed"; readonly degradeReason: string }
  | { readonly kind: "connect-failed"; readonly degradeReason: string }
  | { readonly kind: "mic-permission"; readonly degradeReason: string }
  | { readonly kind: "connection"; readonly degradeReason: string }
  | { readonly kind: "illegal-state"; readonly state: VoiceSessionState; readonly op: string }
  | { readonly kind: "not-started" }
  | { readonly kind: "io-error"; readonly degradeReason: string }

export interface RealtimeVoiceSessionPort {
  /** idle → connecting → listening. Opens transport, sends `session.update`,
   *  emits `audioStart`, starts mic capture + up-pump. Returns Err on
   *  auth/connect/mic-permission failure (session stays `idle`). */
  start(opts: VoiceSessionStartOpts): Promise<Result<void, VoiceSessionError>>

  /** Push-to-talk fallback ONLY: mark end-of-utterance (commit input buffer
   *  + create response). No-op under server_vad (server detects turn end).
   *  Illegal when not `listening` ⇒ Err. */
  commitTurn(): Result<void, VoiceSessionError>

  /** Append typed text mid-session (mixed modality; mirrors AppendText). */
  sendText(text: string): Result<void, VoiceSessionError>

  /** Mute/unmute the mic without tearing down the session. Muted ⇒ mic
   *  chunks are dropped BEFORE the append frame (mirrors composer.mute). */
  setMuted(muted: boolean): Result<void, VoiceSessionError>

  /** Barge-in / cancel the active response (mirrors composer.cancel). Sends
   *  `response.cancel`; transitions `responding → listening`. Illegal when
   *  not `responding` ⇒ Err. */
  interrupt(): Result<void, VoiceSessionError>

  /** Subscribe to session events. Returns an unsubscribe. Throwing handlers
   *  are isolated (HELL-RTV-13). */
  onEvent(handler: (e: VoiceSessionEvent) => void): VoiceSessionUnsubscribe

  /** Current state. Pure. */
  state(): VoiceSessionState

  /** Whether the mic is currently muted. Pure. */
  muted(): boolean

  /** Graceful close. `* → closed`. Idempotent (HELL-RTV-12). */
  close(): Promise<Result<void, VoiceSessionError>>
}
