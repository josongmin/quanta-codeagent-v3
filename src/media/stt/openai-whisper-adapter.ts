import { err, ok, type Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import {
  DEFAULT_STT_TIMEOUT_MS,
  type FetchLike,
  sttInputError,
  sttPost,
  sttReadJson,
  sttResponseError,
} from "./deepgram-adapter"
import type { SpeechToTextPort, TranscribeOpts } from "./port"
import type { SttError, Transcript } from "./types"

export const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
export const WHISPER_MODEL = "whisper-1"

export interface WhisperAdapterOpts {
  readonly apiKey: string
  readonly fetchFn?: FetchLike
  readonly endpoint?: string
  readonly model?: string
}

const fileNameFor = (mime: string): string => (mime === "audio/mp3" ? "audio.mp3" : "audio.wav")

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** The multipart body Whisper wants. A unit so the request shape is stated in
 *  one place instead of three `form.append` lines wedged mid-method. */
const whisperForm = (blob: AudioBlob, model: string): FormData => {
  const form = new FormData()
  form.append("file", new Blob([blob.bytes], { type: blob.mime }), fileNameFor(blob.mime))
  form.append("model", model)
  form.append("response_format", "verbose_json")
  return form
}

/** Whisper's `verbose_json` body → transcript, or the typed reason it is not
 *  usable. A unit because it is the only provider-specific decoding step left
 *  once the transport/status tables are shared; it is also pure, so it is the
 *  part worth testing directly. */
const whisperTranscript = (json: unknown): Result<Transcript, SttError> => {
  if (!isObj(json)) {
    return err({ kind: "no-transcription", degradeReason: "whisper returned non-object body" })
  }
  const text = typeof json.text === "string" ? json.text : ""
  if (text.length === 0) {
    return err({ kind: "no-transcription", degradeReason: "whisper returned empty text" })
  }
  const languageHint = typeof json.language === "string" ? json.language : undefined
  return ok({
    text,
    confidence: 1.0,
    ...(languageHint !== undefined ? { languageHint } : {}),
  })
}

export const createWhisperAdapter = (opts: WhisperAdapterOpts): SpeechToTextPort => {
  const fetchFn: FetchLike = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const endpoint = opts.endpoint ?? WHISPER_ENDPOINT
  const model = opts.model ?? WHISPER_MODEL
  return {
    async transcribe(
      blob: AudioBlob,
      reqOpts?: TranscribeOpts,
    ): Promise<Result<Transcript, SttError>> {
      const bad = sttInputError(blob)
      if (bad !== undefined) return err(bad)
      // T01 (audit L9 H4): deadline + caller signal via the shared primitive so
      // a hung Whisper connection degrades to a typed `timeout` / `aborted`.
      const timeoutMs = reqOpts?.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS
      const posted = await sttPost({
        endpoint,
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: whisperForm(blob, model),
        timeoutMs,
        ...(reqOpts?.signal !== undefined ? { signal: reqOpts.signal } : {}),
        fetchFn,
      })
      if (!posted.ok) return err(posted.error)
      const res = posted.value
      // Whisper reports no Retry-After, so its 429 stays the bare rate-limit error.
      const httpErr = sttResponseError(res, "whisper", () => ({
        kind: "rate-limited",
        status: 429,
      }))
      if (httpErr !== undefined) return err(httpErr)
      const body = await sttReadJson(res, "whisper")
      if (!body.ok) return err(body.error)
      return whisperTranscript(body.value)
    },
  }
}
