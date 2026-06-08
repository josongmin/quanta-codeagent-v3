/**
 * Realtime slice — shared types (ADR-0230).
 *
 * The 4-state lifecycle MUST be queryable (HELL-RT-12). Surfaces use
 * `status()` to render "connecting…" without poking at adapter internals.
 *
 * Closed-union errors so surfaces branch on `kind` exhaustively. Every
 * operational failure is a typed `Err`; throws are reserved for
 * programmer-bug only (the port methods never throw at runtime — they
 * encode invalid input as `Err` variants too).
 */

/** WebSocket lifecycle 4-state — Codex absorption parity (`realtime.status`). */
export type RealtimeStatus = "connecting" | "open" | "closing" | "closed"

/** Audio codec marker. Actual encode/decode is OUT-OF-SCOPE for this MVP —
 *  the marker is used in the SDP negotiate + outbound `audio.start` signal
 *  so the surface (which owns the real `RTCPeerConnection`) can drive its
 *  own media. Pinned by HELL-RT-17. */
export type AudioCodec = "pcm" | "opus"

/** Connect-time options. */
export interface RealtimeConnectOpts {
  readonly endpoint: string
  /** Bearer token sent as `Authorization: Bearer <auth>`. Adapter-specific
   *  if the underlying transport doesn't support a Bearer header (the
   *  default Bun adapter passes it as a subprotocol prefix when needed).
   *  Pinned by HELL-RT-02 (invalid auth → typed Err). */
  readonly auth?: string
  /** Aborts mid-connect. When fired BEFORE `open`, the in-flight WS is
   *  closed and the port transitions straight to `closed`. Pinned by
   *  HELL-RT-10. */
  readonly signal?: AbortSignal
}

/** Send payload — text or binary. Binary round-trips unchanged (HELL-RT-15). */
export type RealtimeFrame = string | Uint8Array

/** Outbound signal envelope for `audioStart` / `audioStop`. The actual
 *  payload sent over the wire is a JSON-stringified version of this shape. */
export type RealtimeOutboundSignal =
  | { readonly type: "audio.start"; readonly format: AudioCodec }
  | { readonly type: "audio.stop" }

/** Inbound frame surfaced to `onMessage` handlers. */
export type RealtimeInboundMessage =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "binary"; readonly data: Uint8Array }

/** SDP negotiate result — text-level only. The surface uses this to
 *  build its own `RTCPeerConnection` if it wants media. */
export interface SdpAnswer {
  readonly sdp: string
  readonly codec: AudioCodec
}

/** §6.5 long-tail — one realtime voice the SERVER advertises (Codex
 *  `ThreadRealtimeListVoices` parity). Surfaces render this to let the user
 *  pick a TTS voice; the list is server-driven (not a hardcoded enum) because a
 *  provider can add/remove voices server-side. `id` is the wire value passed
 *  back on session config; `label` is the human-readable name (defaults to `id`
 *  when the server omits it). */
export interface VoiceInfo {
  readonly id: string
  readonly label: string
  /** Optional descriptor the server may attach (e.g. "warm, conversational"). */
  readonly description?: string
}

/** Realtime errors — closed-union. */
export type RealtimeError =
  | { readonly kind: "not-connected" }
  | { readonly kind: "already-connected" }
  | { readonly kind: "auth-failed"; readonly degradeReason: string }
  | { readonly kind: "connect-failed"; readonly degradeReason: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "invalid-sdp"; readonly degradeReason: string }
  | { readonly kind: "empty-sdp" }
  | { readonly kind: "invalid-frame"; readonly degradeReason: string }
  | { readonly kind: "io-error"; readonly degradeReason: string }
  /** §6.5 — the adapter has no voices provider wired (the default MVP WS has no
   *  voices-list RPC). Surfaces that need it pass a `voicesProvider`. Distinct
   *  from `io-error` so a surface can degrade gracefully (hide the voice picker)
   *  rather than show an error. */
  | { readonly kind: "voices-unsupported" }
