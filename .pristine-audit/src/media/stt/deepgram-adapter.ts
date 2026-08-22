import {
  abortReasonOf,
  err,
  errMessage,
  fetchWithDeadline,
  ok,
  parseRetryAfterMs,
  type Result,
} from "@/shared"
import type { AudioBlob } from "../voice/types"
import type { SpeechToTextPort, TranscribeOpts } from "./port"
import type { SttError, Transcript } from "./types"

export const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true"

/** Default STT round-trip budget (audit L9 H4). A provider connection that
 *  hangs past this degrades to a typed `timeout` instead of blocking forever. */
export const DEFAULT_STT_TIMEOUT_MS = 30_000

/** Minimal fetch surface — `typeof globalThis.fetch` constrained to the
 *  one call shape we make. Lets tests inject a captured-args fake without
 *  monkey-patching the global. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface DeepgramAdapterOpts {
  readonly apiKey: string
  readonly fetchFn?: FetchLike
  readonly endpoint?: string
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
    async transcribe(
      blob: AudioBlob,
      reqOpts?: TranscribeOpts,
    ): Promise<Result<Transcript, SttError>> {
      if (!mimeOk(blob.mime)) {
        return err({ kind: "unsupported-mime", mime: blob.mime })
      }
      if (blob.bytes.byteLength === 0) {
        return err({ kind: "empty-audio" })
      }
      // T01 (audit L9 H4): wire BOTH a deadline AND the caller signal into the
      // fetch via the shared primitive so a hung Deepgram connection cannot
      // block the caller forever. Cancellation maps to a typed `timeout` /
      // `aborted` SttError rather than a silent hang or generic network-error.
      const timeoutMs = reqOpts?.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS
      let res: Response
      try {
        res = await fetchWithDeadline(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Token ${opts.apiKey}`,
            "Content-Type": blob.mime,
          },
          body: blob.bytes,
          timeoutMs,
          ...(reqOpts?.signal !== undefined ? { signal: reqOpts.signal } : {}),
          // The shared primitive types `body` as `unknown` (carrier-agnostic);
          // the adapter's `FetchLike` seam takes `RequestInit`. The body we pass
          // is a real `BodyInit` (Uint8Array), so the bridge cast is sound.
          fetchFn: (input, init) => fetchFn(input, init as RequestInit),
        })
      } catch (e) {
        const reason = abortReasonOf(e)
        if (reason === "timeout") return err({ kind: "timeout", timeoutMs })
        if (reason === "abort") return err({ kind: "aborted" })
        return err({
          kind: "network-error",
          degradeReason: errMessage(e),
        })
      }
      if (res.status === 401 || res.status === 403) {
        return err({ kind: "auth-failed", status: res.status })
      }
      if (res.status === 429) {
        const retry = parseRetryAfterMs((name) => res.headers.get(name))
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
