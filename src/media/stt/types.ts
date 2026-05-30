/**
 * STT (speech-to-text) types (ADR-0202). The transcript carries a
 * `confidence` in [0,1] — for providers that don't surface confidence
 * (OpenAI Whisper), adapters set it to 1.0 and the caller pivots on
 * other signals.
 */

export interface Transcript {
  readonly text: string
  readonly confidence: number
  readonly languageHint?: string
}

export type SttError =
  | { readonly kind: "auth-failed"; readonly status: number }
  | { readonly kind: "rate-limited"; readonly status: number; readonly retryAfterMs?: number }
  | { readonly kind: "no-transcription"; readonly degradeReason: string }
  | {
      readonly kind: "transcription-failed"
      readonly status: number
      readonly degradeReason: string
    }
  | { readonly kind: "unsupported-mime"; readonly mime: string }
  | { readonly kind: "empty-audio" }
  | { readonly kind: "network-error"; readonly degradeReason: string }
  // T01 (audit L9 H4): the STT round-trip now carries a deadline + caller
  // signal. A hung provider connection that exceeds the deadline degrades to
  // a TYPED `timeout` (with the elapsed budget), and a caller-cancelled request
  // degrades to `aborted` — never a silent hang or an untyped network-error.
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "aborted" }
