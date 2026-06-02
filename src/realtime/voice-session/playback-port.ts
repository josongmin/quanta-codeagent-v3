/**
 * Realtime voice-session — `AudioPlaybackPort` down-channel sink
 * (ADR-0439, RFC §6.4).
 *
 * Receives PCM16 audio-delta frames the SERVER already encoded and pipes them
 * to a platform player. It does NO DSP / NO codec — it just hands bytes to a
 * player process. When no player is on PATH, `availability()` returns `null`
 * ⇒ the session degrades to TRANSCRIPT-ONLY (the always-on channel keeps
 * working; RFC §5.2 / §6.3). Injected — no globals.
 *
 * Plane-clean: zero imports (interface only).
 */

import type { Result } from "@/shared"

/** Playback errors — closed-union. */
export type PlaybackError =
  | { readonly kind: "no-player" }
  | { readonly kind: "spawn-failed"; readonly degradeReason: string }
  | { readonly kind: "io-error"; readonly degradeReason: string }

export interface AudioPlaybackPort {
  /** Synchronous probe — returns the player NAME (`"afplay"`/`"ffplay"`/
   *  `"paplay"`) when one is on PATH, else `null`. The session uses this to
   *  decide transcript-only fallback BEFORE routing any audio. */
  availability(): string | null

  /** Append a PCM16 frame to the player stream. `no-player` when nothing is
   *  available (the session drops the frame and stays functional). */
  play(pcm: Uint8Array): Result<void, PlaybackError>

  /** Flush buffered audio (on response.done). Never throws. */
  flush(): Promise<void>

  /** Stop playback immediately (on interrupt / close). Idempotent. */
  stop(): void
}
