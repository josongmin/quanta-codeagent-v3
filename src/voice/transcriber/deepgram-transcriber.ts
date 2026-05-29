/**
 * Deepgram transcriber adapter (ADR-0208).
 *
 * Direct REST POST to `/v1/listen?model=nova-3&smart_format=true` —
 * NOT `@deepgram/sdk` since verify-workflow installs are blocked. The
 * SDK swap is documented as a 1-line adapter-body change:
 *
 *   const client = new DeepgramClient(opts.apiKey)
 *   const result = await client.listen.prerecorded.transcribeFile(
 *     req.audio, { model: "nova-3", smart_format: true, language: req.language }
 *   )
 *
 * Sibling to `@/media/stt/deepgram-adapter` — this one binds to the
 * richer `TranscriberPort` shape (segments + language + abort) for the
 * `/voice` slash command.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { FetchLike } from "./openai-whisper-transcriber"
import type { TranscribeReq, TranscriberError, TranscriberPort, VoiceTranscript } from "./port"

export const DEEPGRAM_ENDPOINT_V3 = "https://api.deepgram.com/v1/listen"
export const DEEPGRAM_MODEL_DEFAULT = "nova-3"

export interface DeepgramTranscriberOpts {
  readonly apiKey: string
  readonly fetchFn?: FetchLike
  readonly endpoint?: string
  readonly model?: string
  /** Per-request timeout. Defaults to 60 s. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

const mimeFor = (format: "wav" | "webm"): string => (format === "webm" ? "audio/webm" : "audio/wav")

const parseRetryAfterMs = (h: string | null): number | undefined => {
  if (h === null) return undefined
  const n = Number(h)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1000)
}

interface DeepgramAlternative {
  readonly transcript?: unknown
  readonly confidence?: unknown
  readonly words?: ReadonlyArray<unknown>
}
interface DeepgramChannel {
  readonly alternatives?: ReadonlyArray<DeepgramAlternative>
}
interface DeepgramResponse {
  readonly results?: {
    readonly channels?: ReadonlyArray<DeepgramChannel>
    readonly utterances?: ReadonlyArray<unknown>
  }
  readonly metadata?: { readonly detected_language?: unknown }
}

interface DeepgramWord {
  readonly word?: unknown
  readonly start?: unknown
  readonly end?: unknown
  readonly punctuated_word?: unknown
}

interface DeepgramUtterance {
  readonly transcript?: unknown
  readonly start?: unknown
  readonly end?: unknown
}

const extractText = (alt: DeepgramAlternative): string =>
  typeof alt.transcript === "string" ? alt.transcript : ""

const utterancesToSegments = (
  raw: ReadonlyArray<unknown> | undefined,
): ReadonlyArray<{ text: string; startMs: number; endMs: number }> | undefined => {
  if (raw === undefined) return undefined
  const out: { text: string; startMs: number; endMs: number }[] = []
  for (const u of raw) {
    if (!isObj(u)) continue
    const ut = u as DeepgramUtterance
    const text = typeof ut.transcript === "string" ? ut.transcript : ""
    const start = typeof ut.start === "number" ? ut.start : 0
    const end = typeof ut.end === "number" ? ut.end : 0
    if (text.length === 0) continue
    out.push({ text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) })
  }
  return out.length > 0 ? out : undefined
}

const wordsToSegments = (
  alt: DeepgramAlternative,
): ReadonlyArray<{ text: string; startMs: number; endMs: number }> | undefined => {
  if (!Array.isArray(alt.words)) return undefined
  // Merge consecutive words into a single segment (Deepgram returns
  // per-word timing; STT consumers want sentence-level grouping).
  const out: { text: string; startMs: number; endMs: number }[] = []
  let cur: { text: string; startMs: number; endMs: number } | undefined
  for (const w of alt.words) {
    if (!isObj(w)) continue
    const dw = w as DeepgramWord
    const piece =
      typeof dw.punctuated_word === "string"
        ? dw.punctuated_word
        : typeof dw.word === "string"
          ? dw.word
          : ""
    const start = typeof dw.start === "number" ? dw.start : 0
    const end = typeof dw.end === "number" ? dw.end : 0
    if (piece.length === 0) continue
    if (cur === undefined) {
      cur = { text: piece, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) }
    } else {
      cur = {
        text: `${cur.text} ${piece}`,
        startMs: cur.startMs,
        endMs: Math.round(end * 1000),
      }
    }
  }
  if (cur !== undefined) out.push(cur)
  return out.length > 0 ? out : undefined
}

const chainSignals = (
  primary: AbortSignal | undefined,
  secondary: AbortSignal,
): AbortController => {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  if (primary !== undefined) {
    if (primary.aborted) ctrl.abort()
    else primary.addEventListener("abort", onAbort, { once: true })
  }
  if (secondary.aborted) ctrl.abort()
  else secondary.addEventListener("abort", onAbort, { once: true })
  return ctrl
}

const classifyStatus = (res: Response): TranscriberError | null => {
  if (res.status === 401 || res.status === 403) return { kind: "auth-failed", status: res.status }
  if (res.status === 429) {
    const retry = parseRetryAfterMs(res.headers.get("retry-after"))
    return retry !== undefined
      ? { kind: "rate-limited", status: 429, retryAfterMs: retry }
      : { kind: "rate-limited", status: 429 }
  }
  if (!res.ok) {
    return {
      kind: "transcription-failed",
      status: res.status,
      degradeReason: `deepgram returned ${res.status}`,
    }
  }
  return null
}

const parseBody = async (res: Response): Promise<Result<VoiceTranscript, TranscriberError>> => {
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
  if (!isObj(json)) {
    return err({ kind: "no-transcription", degradeReason: "deepgram returned non-object body" })
  }
  const resp = json as DeepgramResponse
  const alt = resp.results?.channels?.[0]?.alternatives?.[0]
  if (alt === undefined) {
    return err({ kind: "no-transcription", degradeReason: "deepgram returned no alternatives" })
  }
  const text = extractText(alt)
  if (text.length === 0) {
    return err({ kind: "no-transcription", degradeReason: "deepgram returned empty transcript" })
  }
  const segments = utterancesToSegments(resp.results?.utterances) ?? wordsToSegments(alt)
  const language =
    typeof resp.metadata?.detected_language === "string"
      ? resp.metadata.detected_language
      : undefined
  const base: { text: string } = { text }
  const withLang: VoiceTranscript =
    language !== undefined ? { ...base, language } : (base as VoiceTranscript)
  const final: VoiceTranscript = segments !== undefined ? { ...withLang, segments } : withLang
  return ok(final)
}

interface DoFetchArgs {
  readonly url: string
  readonly fetchFn: FetchLike
  readonly apiKey: string
  readonly req: TranscribeReq
  readonly timeoutMs: number
}

interface FetchOutcome {
  readonly res?: Response
  readonly err?: TranscriberError
}

const doFetch = async (args: DoFetchArgs): Promise<FetchOutcome> => {
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => timeoutCtrl.abort(), args.timeoutMs)
  const chain = chainSignals(args.req.signal, timeoutCtrl.signal)
  const startedAt = Date.now()
  try {
    const res = await args.fetchFn(args.url, {
      method: "POST",
      headers: {
        Authorization: `Token ${args.apiKey}`,
        "Content-Type": mimeFor(args.req.format),
      },
      body: args.req.audio,
      signal: chain.signal,
    })
    clearTimeout(timer)
    return { res }
  } catch (e) {
    clearTimeout(timer)
    const timedOut = timeoutCtrl.signal.aborted
    if (args.req.signal?.aborted === true && !timedOut) {
      return { err: { kind: "aborted" } }
    }
    if (timedOut) {
      return { err: { kind: "timeout", elapsedMs: Date.now() - startedAt } }
    }
    return {
      err: {
        kind: "network-error",
        degradeReason: errMessage(e),
      },
    }
  }
}

const buildUrl = (endpoint: string, model: string, language: string | undefined): string => {
  const u = new URL(endpoint)
  u.searchParams.set("model", model)
  u.searchParams.set("smart_format", "true")
  if (language !== undefined && language.length > 0) u.searchParams.set("language", language)
  return u.toString()
}

export const createDeepgramTranscriber = (opts: DeepgramTranscriberOpts): TranscriberPort => {
  const fetchFn: FetchLike = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const endpoint = opts.endpoint ?? DEEPGRAM_ENDPOINT_V3
  const model = opts.model ?? DEEPGRAM_MODEL_DEFAULT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async transcribe(req: TranscribeReq): Promise<Result<VoiceTranscript, TranscriberError>> {
      if (req.format !== "wav" && req.format !== "webm") {
        return err({ kind: "unsupported-format", format: req.format })
      }
      if (req.audio.byteLength === 0) {
        return err({ kind: "empty-audio" })
      }
      if (req.signal?.aborted === true) {
        return err({ kind: "aborted" })
      }
      const url = buildUrl(endpoint, model, req.language)
      const outcome = await doFetch({ url, fetchFn, apiKey: opts.apiKey, req, timeoutMs })
      if (outcome.err !== undefined) return err(outcome.err)
      const res = outcome.res as Response
      const statusErr = classifyStatus(res)
      if (statusErr !== null) return err(statusErr)
      return parseBody(res)
    },
  }
}
