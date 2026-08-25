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

/** The two pre-flight rejections every STT adapter owes the caller before it
 *  spends a network round-trip. One unit because both adapters must reject the
 *  same inputs the same way — duplicating the pair is how they drift apart.
 *  Returns `undefined` when the blob is acceptable. */
export const sttInputError = (blob: AudioBlob): SttError | undefined => {
  if (!mimeOk(blob.mime)) return { kind: "unsupported-mime", mime: blob.mime }
  if (blob.bytes.byteLength === 0) return { kind: "empty-audio" }
  return undefined
}

/** Cancellation/transport table: maps a throw out of {@link fetchWithDeadline}
 *  onto the typed transport errors. One unit because the abort-reason mapping is
 *  provider-independent — a deadline is a deadline. */
export const sttTransportError = (e: unknown, timeoutMs: number): SttError => {
  const reason = abortReasonOf(e)
  if (reason === "timeout") return { kind: "timeout", timeoutMs }
  if (reason === "abort") return { kind: "aborted" }
  return { kind: "network-error", degradeReason: errMessage(e) }
}

/** Everything an STT adapter varies about its one POST. */
export interface SttPostInit {
  readonly endpoint: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly fetchFn: FetchLike
}

/** The deadline-wired POST both adapters make, with its catch already folded
 *  into {@link sttTransportError}. A unit because the try/catch around
 *  `fetchWithDeadline` is the same six lines in every adapter, and because
 *  hoisting it out of the factory closure removes the nesting surcharge that
 *  the transcribe methods were paying for it. */
export const sttPost = async (init: SttPostInit): Promise<Result<Response, SttError>> => {
  try {
    return ok(
      await fetchWithDeadline(init.endpoint, {
        method: "POST",
        headers: init.headers,
        body: init.body,
        timeoutMs: init.timeoutMs,
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        // The shared primitive types `body` as `unknown` (carrier-agnostic);
        // the adapter's `FetchLike` seam takes `RequestInit`. The bodies we pass
        // are real `BodyInit`s (Uint8Array / FormData), so the bridge cast is sound.
        fetchFn: (input, i) => init.fetchFn(input, i as RequestInit),
      }),
    )
  } catch (e) {
    return err(sttTransportError(e, init.timeoutMs))
  }
}

/** HTTP status table shared by the adapters. `rateLimited` stays a parameter
 *  because only Deepgram surfaces a `Retry-After` hint — folding it in would
 *  silently add a field to Whisper's error. Returns `undefined` for a usable
 *  response. */
export const sttResponseError = (
  res: Response,
  provider: string,
  rateLimited: () => SttError,
): SttError | undefined => {
  if (res.status === 401 || res.status === 403) return { kind: "auth-failed", status: res.status }
  if (res.status === 429) return rateLimited()
  if (!res.ok) {
    return {
      kind: "transcription-failed",
      status: res.status,
      degradeReason: `${provider} returned ${res.status}`,
    }
  }
  return undefined
}

/** Body read with its parse failure already typed. A unit for the same reason
 *  as {@link sttPost}: an identical try/catch in both adapters, and one fewer
 *  nested catch inside the factory closure. */
export const sttReadJson = async (
  res: Response,
  provider: string,
): Promise<Result<unknown, SttError>> => {
  try {
    return ok(await res.json())
  } catch (e) {
    return err({
      kind: "transcription-failed",
      status: res.status,
      degradeReason: `${provider} JSON parse failed: ${errMessage(e)}`,
    })
  }
}

/** Deepgram's 429 payload: the `Retry-After` hint when the header parses,
 *  the bare rate-limit error when it does not. */
const deepgramRateLimited = (res: Response): SttError => {
  const retry = parseRetryAfterMs((name) => res.headers.get(name))
  return retry !== undefined
    ? { kind: "rate-limited", status: 429, retryAfterMs: retry }
    : { kind: "rate-limited", status: 429 }
}

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
      const bad = sttInputError(blob)
      if (bad !== undefined) return err(bad)
      // T01 (audit L9 H4): wire BOTH a deadline AND the caller signal into the
      // fetch via the shared primitive so a hung Deepgram connection cannot
      // block the caller forever. Cancellation maps to a typed `timeout` /
      // `aborted` SttError rather than a silent hang or generic network-error.
      const timeoutMs = reqOpts?.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS
      const posted = await sttPost({
        endpoint,
        headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": blob.mime },
        body: blob.bytes,
        timeoutMs,
        ...(reqOpts?.signal !== undefined ? { signal: reqOpts.signal } : {}),
        fetchFn,
      })
      if (!posted.ok) return err(posted.error)
      const res = posted.value
      const httpErr = sttResponseError(res, "deepgram", () => deepgramRateLimited(res))
      if (httpErr !== undefined) return err(httpErr)
      const body = await sttReadJson(res, "deepgram")
      if (!body.ok) return err(body.error)
      const alt = extractAlt(body.value)
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
