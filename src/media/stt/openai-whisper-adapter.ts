import { err, ok, type Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import type { FetchLike } from "./deepgram-adapter"
import type { SpeechToTextPort } from "./port"
import type { SttError, Transcript } from "./types"

export const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
export const WHISPER_MODEL = "whisper-1"

export interface WhisperAdapterOpts {
  readonly apiKey: string
  readonly fetchFn?: FetchLike
  readonly endpoint?: string
  readonly model?: string
}

const mimeOk = (mime: string): boolean => mime === "audio/wav" || mime === "audio/mp3"
const fileNameFor = (mime: string): string => (mime === "audio/mp3" ? "audio.mp3" : "audio.wav")

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

export const createWhisperAdapter = (opts: WhisperAdapterOpts): SpeechToTextPort => {
  const fetchFn: FetchLike = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const endpoint = opts.endpoint ?? WHISPER_ENDPOINT
  const model = opts.model ?? WHISPER_MODEL
  return {
    async transcribe(blob: AudioBlob): Promise<Result<Transcript, SttError>> {
      if (!mimeOk(blob.mime)) {
        return err({ kind: "unsupported-mime", mime: blob.mime })
      }
      if (blob.bytes.byteLength === 0) {
        return err({ kind: "empty-audio" })
      }
      const form = new FormData()
      form.append("file", new Blob([blob.bytes], { type: blob.mime }), fileNameFor(blob.mime))
      form.append("model", model)
      form.append("response_format", "verbose_json")

      let res: Response
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}` },
          body: form,
        })
      } catch (e) {
        return err({
          kind: "network-error",
          degradeReason: e instanceof Error ? e.message : String(e),
        })
      }
      if (res.status === 401 || res.status === 403) {
        return err({ kind: "auth-failed", status: res.status })
      }
      if (res.status === 429) {
        return err({ kind: "rate-limited", status: 429 })
      }
      if (!res.ok) {
        return err({
          kind: "transcription-failed",
          status: res.status,
          degradeReason: `whisper returned ${res.status}`,
        })
      }
      let json: unknown
      try {
        json = await res.json()
      } catch (e) {
        return err({
          kind: "transcription-failed",
          status: res.status,
          degradeReason: `whisper JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
      if (!isObj(json)) {
        return err({
          kind: "no-transcription",
          degradeReason: "whisper returned non-object body",
        })
      }
      const text = typeof json.text === "string" ? json.text : ""
      if (text.length === 0) {
        return err({
          kind: "no-transcription",
          degradeReason: "whisper returned empty text",
        })
      }
      const languageHint = typeof json.language === "string" ? json.language : undefined
      return ok({
        text,
        confidence: 1.0,
        ...(languageHint !== undefined ? { languageHint } : {}),
      })
    },
  }
}
