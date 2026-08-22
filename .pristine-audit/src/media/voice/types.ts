/**
 * Voice-input types (ADR-0202) — leaf-level shapes for the audio capture
 * primitive. The capture port returns `Result<AudioBlob, CaptureError>`
 * so operational failures (sox missing, abort, invalid duration) are
 * routed without throws.
 */

/** A captured audio payload. Mime is restricted to the two container
 *  formats both Deepgram and OpenAI Whisper accept verbatim. */
export interface AudioBlob {
  readonly mime: "audio/wav" | "audio/mp3"
  readonly bytes: Uint8Array
  readonly durationMs: number
}

/** Capture-side errors. Closed-union — surface renderers exhaustively
 *  branch on `kind`. `degradeReason` is human-readable extra context. */
export type CaptureError =
  | { readonly kind: "sox-missing"; readonly degradeReason: string }
  | { readonly kind: "invalid-duration"; readonly secs: number }
  | { readonly kind: "aborted"; readonly degradeReason?: string }
  | { readonly kind: "spawn-failed"; readonly degradeReason: string }
