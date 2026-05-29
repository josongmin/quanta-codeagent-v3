/**
 * OpenAI Whisper transcriber adapter (ADR-0208).
 *
 * Direct REST POST to `/v1/audio/transcriptions` with `response_format=
 * verbose_json` so segments + language come back populated. Reuses the
 * existing OpenAI API key the user already configured for the LLM
 * provider.
 *
 * Sibling to `@/media/stt/openai-whisper-adapter` — this one binds to
 * the richer `TranscriberPort` shape (segments + language + abort) for
 * the `/voice` slash. Swap to the official `openai` npm SDK
 * (`client.audio.transcriptions.create`) is a 1-line adapter-body
 * change; the REST path stays as the verify-workflow install-blocked
 * default.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { TranscribeReq, TranscriberError, TranscriberPort, VoiceTranscript } from "./port"

export const WHISPER_ENDPOINT_V3 = "https://api.openai.com/v1/audio/transcriptions"
export const WHISPER_MODEL_V3 = "whisper-1"

/** Minimal fetch surface — tests inject a captured-args fake without
 *  monkey-patching the global. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface WhisperTranscriberOpts {
  readonly apiKey: string
  readonly fetchFn?: FetchLike
  readonly endpoint?: string
  readonly model?: string
  /** Per-request timeout in ms. Defaults to 60 s (Whisper sync API can
   *  take up to ~30 s for a 25-MB upload). When exceeded, the in-flight
   *  fetch is aborted and `Err({kind:"timeout"})` is returned. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

const fileNameFor = (format: "wav" | "webm"): string =>
  format === "webm" ? "audio.webm" : "audio.wav"

const mimeFor = (format: "wav" | "webm"): string => (format === "webm" ? "audio/webm" : "audio/wav")

interface WhisperSegmentRaw {
  readonly text?: unknown
  readonly start?: unknown
  readonly end?: unknown
}

const extractSegments = (
  json: Record<string, unknown>,
):
  | ReadonlyArray<{
      text: string
      startMs: number
      endMs: number
    }>
  | undefined => {
  const raw = json.segments
  if (!Array.isArray(raw)) return undefined
  const out: { text: string; startMs: number; endMs: number }[] = []
  for (const seg of raw as ReadonlyArray<unknown>) {
    if (!isObj(seg)) continue
    const s = seg as WhisperSegmentRaw
    const text = typeof s.text === "string" ? s.text : ""
    const start = typeof s.start === "number" ? s.start : 0
    const end = typeof s.end === "number" ? s.end : 0
    if (text.length === 0) continue
    out.push({
      text,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
    })
  }
  return out.length > 0 ? out : undefined
}

/** Chain two AbortSignals — the returned controller aborts when either
 *  parent aborts. Used to merge the caller's signal with our internal
 *  timeout signal. */
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

interface ParseFetchErrorArgs {
  readonly e: unknown
  readonly signal: AbortSignal | undefined
  readonly timedOut: boolean
  readonly elapsedMs: number
}

const parseFetchError = (args: ParseFetchErrorArgs): TranscriberError => {
  const { e, signal, timedOut, elapsedMs } = args
  if (signal?.aborted === true && !timedOut) return { kind: "aborted" }
  if (timedOut) return { kind: "timeout", elapsedMs }
  return {
    kind: "network-error",
    degradeReason: errMessage(e),
  }
}

const buildForm = (req: TranscribeReq, model: string): FormData => {
  const form = new FormData()
  form.append("file", new Blob([req.audio], { type: mimeFor(req.format) }), fileNameFor(req.format))
  form.append("model", model)
  form.append("response_format", "verbose_json")
  if (typeof req.language === "string" && req.language.length > 0) {
    form.append("language", req.language)
  }
  return form
}

interface DoFetchArgs {
  readonly endpoint: string
  readonly fetchFn: FetchLike
  readonly apiKey: string
  readonly form: FormData
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
  let timedOut = false
  const timeoutFired = (): boolean => {
    timedOut = timeoutCtrl.signal.aborted
    return timedOut
  }
  try {
    const res = await args.fetchFn(args.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: args.form,
      signal: chain.signal,
    })
    clearTimeout(timer)
    return { res }
  } catch (e) {
    clearTimeout(timer)
    return {
      err: parseFetchError({
        e,
        signal: args.req.signal,
        timedOut: timeoutFired(),
        elapsedMs: Date.now() - startedAt,
      }),
    }
  }
}

const classifyStatus = (res: Response): TranscriberError | null => {
  if (res.status === 401 || res.status === 403) return { kind: "auth-failed", status: res.status }
  if (res.status === 429) return { kind: "rate-limited", status: 429 }
  if (!res.ok) {
    return {
      kind: "transcription-failed",
      status: res.status,
      degradeReason: `whisper returned ${res.status}`,
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
      degradeReason: `whisper JSON parse failed: ${errMessage(e)}`,
    })
  }
  if (!isObj(json)) {
    return err({ kind: "no-transcription", degradeReason: "whisper returned non-object body" })
  }
  const text = typeof json.text === "string" ? json.text : ""
  if (text.length === 0) {
    return err({ kind: "no-transcription", degradeReason: "whisper returned empty text" })
  }
  const language = typeof json.language === "string" ? json.language : undefined
  const segments = extractSegments(json)
  // exactOptionalPropertyTypes: build a base object then conditionally
  // attach optional fields (NEVER `language: undefined`).
  const base: { text: string } = { text }
  const withLang: VoiceTranscript =
    language !== undefined ? { ...base, language } : (base as VoiceTranscript)
  const final: VoiceTranscript = segments !== undefined ? { ...withLang, segments } : withLang
  return ok(final)
}

export const createOpenAIWhisperTranscriber = (opts: WhisperTranscriberOpts): TranscriberPort => {
  const fetchFn: FetchLike = opts.fetchFn ?? ((input, init) => fetch(input, init))
  const endpoint = opts.endpoint ?? WHISPER_ENDPOINT_V3
  const model = opts.model ?? WHISPER_MODEL_V3
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
      const form = buildForm(req, model)
      const outcome = await doFetch({
        endpoint,
        fetchFn,
        apiKey: opts.apiKey,
        form,
        req,
        timeoutMs,
      })
      if (outcome.err !== undefined) return err(outcome.err)
      const res = outcome.res as Response
      const statusErr = classifyStatus(res)
      if (statusErr !== null) return err(statusErr)
      return parseBody(res)
    },
  }
}
