/**
 * TranscriberPort (ADR-0208).
 *
 * Sibling to `@/media/stt/port`'s `SpeechToTextPort` (ADR-0202). This
 * shape extends with `segments` + `language` + `abort` so the `/voice`
 * slash command can show progress / cancel mid-transcription / honor a
 * `--lang` flag. The leaf port is intentionally minimal (one method, one
 * response); the slash port adds the surface ergonomics.
 *
 * Plane-clean: imports only `@/shared` + sibling types. Zero @/agent /
 * @/tool / @/llm / @/mcp / @/permission.
 *
 * Contract:
 *   - NO-THROW: every call returns `Result<…>`.
 *   - `transcribe({ audio, format, language?, signal? })`: single
 *     request/response. Streaming is a follow-up slice (Deepgram
 *     WebSocket; Whisper does not stream).
 *   - On `signal.aborted`, the adapter cancels the in-flight fetch and
 *     resolves with `Err({kind:"aborted"})`.
 *   - The returned `Transcript` has REQUIRED `text` + OPTIONAL
 *     `segments` / `language` (omitted when the vendor does not provide
 *     them). exactOptionalPropertyTypes: never `language: undefined`.
 */

import type { Result } from "@/shared"
import type { RecorderFormat } from "../types"

/** Transcription request — the audio bytes + recorder format + caller
 *  knobs. `language` is an ISO-639-1 hint (e.g. `"en"`, `"ko"`). When
 *  omitted, the vendor auto-detects. */
export interface TranscribeReq {
  readonly audio: Uint8Array
  readonly format: RecorderFormat
  readonly language?: string
  readonly signal?: AbortSignal
}

/** Per-segment timing — vendors that surface segments (Whisper
 *  `verbose_json`, Deepgram nova-3) populate this; others omit. */
export interface TranscriptSegment {
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}

/** Transcription response. `segments` + `language` are OMITTED when the
 *  vendor does not provide them (never `undefined`). */
export interface VoiceTranscript {
  readonly text: string
  readonly segments?: ReadonlyArray<TranscriptSegment>
  readonly language?: string
}

/** Closed-union errors. Surfaces branch on `kind` exhaustively. */
export type TranscriberError =
  | { readonly kind: "auth-failed"; readonly status: number }
  | { readonly kind: "rate-limited"; readonly status: number; readonly retryAfterMs?: number }
  | {
      readonly kind: "transcription-failed"
      readonly status: number
      readonly degradeReason: string
    }
  | { readonly kind: "no-transcription"; readonly degradeReason: string }
  | { readonly kind: "unsupported-format"; readonly format: string }
  | { readonly kind: "empty-audio" }
  | { readonly kind: "network-error"; readonly degradeReason: string }
  | { readonly kind: "timeout"; readonly elapsedMs: number }
  | { readonly kind: "aborted" }

export interface TranscriberPort {
  transcribe(req: TranscribeReq): Promise<Result<VoiceTranscript, TranscriberError>>
}
