/**
 * Realtime voice-session — pure `session.update` payload builder
 * (ADR-0439, RFC §4.2). Mirrors Codex's `Session` config 1:1.
 *
 * No tuned heuristics: VAD knobs are passed THROUGH from config. When a knob
 * is omitted we DO NOT emit it — the Realtime API applies its documented
 * default server-side (RFC §3.3, no-heuristics-only-validated). Push-to-talk
 * mode emits `turn_detection: null` so the server does no auto-turn-end.
 *
 * Plane-clean: zero imports beyond sibling types. Pure — same input ⇒ same
 * JSON (string-stable, used directly in HELL-RTV-01/04 assertions).
 */

import type { ServerVadConfig, VoiceTurnMode } from "./port"

/** Default output voice when the surface/config doesn't pick one. The Realtime
 *  API ships several; "alloy" is the GA default (NOT a tuned heuristic — it is
 *  the vendor's documented default voice). */
export const DEFAULT_VOICE = "alloy"

/** PCM16 sample rate the Realtime API accepts/emits (RFC §3.4). This is the
 *  API's wire format, not a tuned number. */
export const REALTIME_PCM_RATE = 24_000

export interface SessionConfigInput {
  readonly model: string
  readonly mode: VoiceTurnMode
  readonly voice: string
  readonly instructions?: string
  readonly vad?: ServerVadConfig
}

/** The `session.update` envelope shape we serialize and `transport.send`. */
export interface SessionUpdatePayload {
  readonly type: "session.update"
  readonly session: Record<string, unknown>
}

/**
 * Build the `session.update` payload. Server-VAD vs push-to-talk diverges only
 * on the `turn_detection` field (RFC §3.3).
 */
export const buildSessionUpdate = (input: SessionConfigInput): SessionUpdatePayload => {
  // turn_detection: null under push_to_talk (the server does no turn-end
  // detection; the surface drives commitTurn). Under server_vad we pass the
  // config knobs THROUGH; omitted knobs are left to the API's own defaults.
  let turnDetection: Record<string, unknown> | null
  if (input.mode === "push_to_talk") {
    turnDetection = null
  } else {
    turnDetection = {
      type: "server_vad",
      // barge-in + auto-response are the conversational contract (RFC §3.3),
      // not tuned numbers — they are boolean behavior switches the RFC pins.
      interrupt_response: true,
      create_response: true,
    }
    if (input.vad?.threshold !== undefined) turnDetection.threshold = input.vad.threshold
    if (input.vad?.prefixPaddingMs !== undefined) {
      turnDetection.prefix_padding_ms = input.vad.prefixPaddingMs
    }
    if (input.vad?.silenceDurationMs !== undefined) {
      turnDetection.silence_duration_ms = input.vad.silenceDurationMs
    }
  }

  const session: Record<string, unknown> = {
    model: input.model,
    output_modalities: ["audio", "text"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: REALTIME_PCM_RATE },
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: turnDetection,
      },
      output: {
        format: { type: "audio/pcm", rate: REALTIME_PCM_RATE },
        voice: input.voice,
      },
    },
  }
  if (input.instructions !== undefined) session.instructions = input.instructions

  return { type: "session.update", session }
}
