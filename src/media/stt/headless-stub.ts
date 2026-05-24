import { ok, type Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import type { SpeechToTextPort } from "./port"
import type { SttError, Transcript } from "./types"

/** No-network, deterministic STT for CI + headless tests. Always returns
 *  `{text:"test transcription", confidence:1.0}` regardless of input. */
export const headlessSpeechToText = (): SpeechToTextPort => ({
  async transcribe(_blob: AudioBlob): Promise<Result<Transcript, SttError>> {
    return ok({ text: "test transcription", confidence: 1.0 })
  },
})
