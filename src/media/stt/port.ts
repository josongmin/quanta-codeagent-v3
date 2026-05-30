import type { Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import type { SttError, Transcript } from "./types"

/** T01 (audit L9 H4): cancellation + deadline for a transcription round-trip.
 *  Optional so existing callers are byte-identical; when supplied the adapter
 *  wires BOTH into the underlying fetch via the shared `fetchWithDeadline`
 *  primitive so a hung provider connection cannot block the caller forever. */
export interface TranscribeOpts {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/**
 * Speech-to-text port (ADR-0202). Adapters wrap a single REST round-trip
 * (Deepgram or OpenAI Whisper today) or return a canned response (headless
 * stub). All operational failures are encoded as `Err<SttError>` — never
 * thrown — so the host overlay can render a single status line.
 */
export interface SpeechToTextPort {
  transcribe(blob: AudioBlob, opts?: TranscribeOpts): Promise<Result<Transcript, SttError>>
}
