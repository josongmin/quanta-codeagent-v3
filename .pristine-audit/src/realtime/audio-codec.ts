/**
 * Realtime slice — audio codec negotiation (ADR-0230).
 *
 * Pure functions. MARKER ONLY — this slice does NOT encode or decode
 * audio. The negotiator picks the first codec from `offered` that appears
 * in `supported`. The actual `libopus` / PCM transcoders are
 * OUT-OF-SCOPE for the MVP (deferred to a follow-up slice that owns
 * media).
 *
 * Why marker-only:
 *   - Real opus/pcm encode/decode needs native bindings (`libopus` /
 *     `node-opus` / etc.) which the install gate blocks.
 *   - The handshake is the load-bearing part of the surface: surfaces
 *     building their own `RTCPeerConnection` use the codec marker to set
 *     `RTCRtpSender.setParameters({encodings:[{codec:...}]})`. They
 *     don't need our slice to do the actual encode.
 *
 * Plane-clean: imports only `@/shared`.
 */

import type { AudioCodec } from "./types"

/** Default codec preference when both sides support PCM and Opus. Opus
 *  wins (better quality at same bitrate) — matches Codex absorption. */
export const DEFAULT_CODEC_PREFERENCE: readonly AudioCodec[] = ["opus", "pcm"] as const

/**
 * Pick the first codec from `offered` that appears in `supported`. Returns
 * `null` when there's no overlap — surfaces decide whether to retry with a
 * relaxed `supported` list or abandon. Pure: same input → same output.
 */
export const negotiateCodec = (
  offered: readonly AudioCodec[],
  supported: readonly AudioCodec[],
): AudioCodec | null => {
  for (const codec of offered) {
    if (supported.includes(codec)) return codec
  }
  return null
}

/** Marker-only encode wrapper. Returns the input unchanged with the codec
 *  tag attached — actual encode is deferred. Surfaces that need real
 *  encoding wire their own transcoder behind a sibling port. */
export const wrapAudioChunk = (
  codec: AudioCodec,
  raw: Uint8Array,
): { readonly codec: AudioCodec; readonly bytes: Uint8Array } => ({
  codec,
  bytes: raw,
})
