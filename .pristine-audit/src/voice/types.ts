/**
 * Voice slice — shared types (ADR-0208).
 *
 * Sibling to `@/media/voice/types` (ADR-0202) — that slice uses an
 * `AudioBlob` triple `{mime, bytes, durationMs}` for the one-shot
 * `captureOnce()` shape. This slice's `AudioBytes` is the handle-based
 * recorder's deliverable: the wav buffer + the format the recorder was
 * configured for. Duration is derived from the wav header at
 * transcription time (the recorder doesn't know when the user pressed
 * Enter, only how many bytes arrived).
 *
 * Closed-union errors so surfaces exhaustively branch on `kind`.
 */

/** Recorder formats — the two containers every modern STT vendor accepts
 *  verbatim. `webm/opus` is the browser-native shape (when we later add a
 *  Tauri surface) — listed for forward-compat; the CLI recorders only
 *  emit wav today. */
export type RecorderFormat = "wav" | "webm"

/** Configurable knobs for `start()`. `rate` and `channels` are the only
 *  ones recorder backends differ on; all default to 16 kHz mono (matches
 *  Deepgram's nova-3 + Whisper's standard input). */
export interface RecorderStartOpts {
  readonly format?: RecorderFormat
  readonly rate?: number
  readonly channels?: 1 | 2
  /** Aborts mid-record. When fired, the handle's spawner is SIGTERM'd;
   *  the surface still calls `stop()` to receive whatever buffered. */
  readonly signal?: AbortSignal
  /** Cap on captured bytes. Defaults to 25 MiB (≈26 minutes of 16k mono
   *  wav). When exceeded, the recorder SIGTERMs and `stop()` returns
   *  `Err({kind:"oversize"})`. Pinned by HELL-VR-04. */
  readonly maxBytes?: number
}

/** Opaque handle returned by `start()`. The surface treats it as a token
 *  — pass it back to `stop()` unchanged. Fields are typed for the
 *  internal recorder impl to read; surfaces SHOULD NOT poke at them. */
export interface RecorderHandle {
  readonly backend: string
  readonly format: RecorderFormat
  readonly rate: number
  readonly channels: 1 | 2
  /** Internal: closure that performs the stop+drain. The default impl
   *  builds this so `stop()` can be invoked without re-resolving the
   *  spawner. Captures `bytesRef` so abort-on-cap can pre-truncate. */
  readonly _internal: {
    readonly stopAndDrain: () => Promise<RecorderInternalResult>
    readonly kill: (sig: string) => void
  }
}

/** Internal result the closure returns. Shape mirrors the public Result
 *  so the public `stop()` is a 1-line lift. */
export type RecorderInternalResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: RecorderError }

/** Drained recorder output. */
export interface AudioBytes {
  readonly format: RecorderFormat
  readonly bytes: Uint8Array
  readonly rate: number
  readonly channels: 1 | 2
}

/** Recorder-side errors. Surfaces branch on `kind` exhaustively. */
export type RecorderError =
  | { readonly kind: "backend-missing"; readonly degradeReason: string }
  | { readonly kind: "spawn-failed"; readonly degradeReason: string }
  | { readonly kind: "invalid-opts"; readonly degradeReason: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "oversize"; readonly maxBytes: number }
  | { readonly kind: "io-error"; readonly degradeReason: string }
