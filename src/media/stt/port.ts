import type { Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import type { SttError, Transcript } from "./types"

/**
 * Speech-to-text port (ADR-0202). Adapters wrap a single REST round-trip
 * (Deepgram or OpenAI Whisper today) or return a canned response (headless
 * stub). All operational failures are encoded as `Err<SttError>` — never
 * thrown — so the host overlay can render a single status line.
 */
export interface SpeechToTextPort {
  transcribe(blob: AudioBlob): Promise<Result<Transcript, SttError>>
}
