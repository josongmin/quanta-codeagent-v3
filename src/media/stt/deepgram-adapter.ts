import { err, errMessage, ok, type Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import type { SpeechToTextPort } from "./port"
import type { SttError, Transcript } from "./types"

export const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true"

/** Minimal fetch surface — `typeof globalThis.fetch` constrained to the
 *  one call shape we make. Lets tests inject a captured-args fake without
 *  monkey-patching the global. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface DeepgramAdapterOpts {
  readonly apiKey: string
  readonly fetchFn?: FetchLike
  readonly endpoint?: string
}

const parseRetryAfterMs = (h: string | null): number | undefined => {
  if (h === null) return undefined
  const n = Number(h)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1000)
}

const mimeOk = (mime: string): boolean => mime === "audio/wav" || mime === "audio/mp3"

interface DeepgramAlternative {
  readonly transcript?: unknown
  readonly confidence?: unknown
}
interface DeepgramChannel {
  readonly alternatives?: ReadonlyArray<DeepgramAlternative>
}
interface DeepgramResponse {
  readonly results?: { readonly channels?: ReadonlyArray<DeepgramChannel> }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

const extractAlt = (json: unknown): { text: string; confidence: number } | null => {
  if (!isObj(json)) return null
  const resp = json as DeepgramResponse
  const ch = resp.results?.channels?.[0]
  const alt = ch?.alternatives?.[0]
  if (alt === undefined) return null
  const text = typeof alt.transcript === "string" ? alt.transcript : ""
  const conf = typeof alt.confidence === "number" ? alt.confidence : 1.0
  if (text.length === 0) return null
  return { text, confidence: conf }
}

export const createDeepgramAdapter = (opts: DeepgramAdapterOpts): SpeechToTextPort => {
  const fetchFn: FetchLike = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const endpoint = opts.endpoint ?? DEEPGRAM_ENDPOINT
  return {
    async transcribe(blob: AudioBlob): Promise<Result<Transcript, SttError>> {
      if (!mimeOk(blob.mime)) {
        return err({ kind: "unsupported-mime", mime: blob.mime })
      }
      if (blob.bytes.byteLength === 0) {
        return err({ kind: "empty-audio" })
      }
      let res: Response
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Token ${opts.apiKey}`,
            "Content-Type": blob.mime,
          },
          body: blob.bytes,
        })
      } catch (e) {
        return err({
          kind: "network-error",
          degradeReason: errMessage(e),
        })
      }
      if (res.status === 401 || res.status === 403) {
        return err({ kind: "auth-failed", status: res.status })
      }
      if (res.status === 429) {
        const retry = parseRetryAfterMs(res.headers.get("retry-after"))
        return err(
          retry !== undefined
            ? { kind: "rate-limited", status: 429, retryAfterMs: retry }
            : { kind: "rate-limited", status: 429 },
        )
      }
      if (!res.ok) {
        return err({
          kind: "transcription-failed",
          status: res.status,
          degradeReason: `deepgram returned ${res.status}`,
        })
      }
      let json: unknown
      try {
        json = await res.json()
      } catch (e) {
        return err({
          kind: "transcription-failed",
          status: res.status,
          degradeReason: `deepgram JSON parse failed: ${errMessage(e)}`,
        })
      }
      const alt = extractAlt(json)
      if (alt === null) {
        return err({
          kind: "no-transcription",
          degradeReason: "deepgram returned no alternatives or empty transcript",
        })
      }
      return ok({ text: alt.text, confidence: alt.confidence })
    },
  }
}
