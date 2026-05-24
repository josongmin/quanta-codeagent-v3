import type { Result } from "@/shared"
import type { AudioBlob } from "../voice/types"
import { createDeepgramAdapter, type FetchLike } from "./deepgram-adapter"
import { headlessSpeechToText } from "./headless-stub"
import { createWhisperAdapter } from "./openai-whisper-adapter"
import type { SpeechToTextPort } from "./port"
import type { SttError, Transcript } from "./types"

export type SttSelection = "deepgram" | "whisper" | "headless-stub"

export interface SttRegistryOpts {
  /** Defaults to `process.env`. Inject for tests. */
  readonly env?: Record<string, string | undefined>
  /** Single fetch impl used by both adapters; inject in tests. */
  readonly fetchFn?: FetchLike
  /** When both `DEEPGRAM_API_KEY` and `OPENAI_API_KEY` are set, retry
   *  whisper if deepgram returned a non-`unsupported-mime`/`empty-audio` Err.
   *  Default: false (deterministic single-shot). */
  readonly fallbackOnError?: boolean
}

/** Inspect env and report which adapter `selectSttAdapter` would pick.
 *  Independent of construction so the overlay can render the choice. */
export const selectSttAdapter = (env: Record<string, string | undefined>): SttSelection => {
  if (typeof env.DEEPGRAM_API_KEY === "string" && env.DEEPGRAM_API_KEY.length > 0) {
    return "deepgram"
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0) {
    return "whisper"
  }
  return "headless-stub"
}

const isInputErr = (e: SttError): boolean =>
  e.kind === "unsupported-mime" || e.kind === "empty-audio"

/** Build a single STT port from env. When both keys exist + `fallbackOnError`
 *  is set, a deepgram failure (other than input-shape errors) chains to
 *  whisper as a single retry. */
export const createSttFromEnv = (opts: SttRegistryOpts = {}): SpeechToTextPort => {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const dg = env.DEEPGRAM_API_KEY
  const oa = env.OPENAI_API_KEY
  const hasDg = typeof dg === "string" && dg.length > 0
  const hasOa = typeof oa === "string" && oa.length > 0

  if (!hasDg && !hasOa) return headlessSpeechToText()

  if (hasDg && hasOa && opts.fallbackOnError === true) {
    const primary = createDeepgramAdapter({
      apiKey: dg as string,
      ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    })
    const secondary = createWhisperAdapter({
      apiKey: oa as string,
      ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    })
    return {
      async transcribe(blob: AudioBlob): Promise<Result<Transcript, SttError>> {
        const first = await primary.transcribe(blob)
        if (first.ok) return first
        if (isInputErr(first.error)) return first
        return secondary.transcribe(blob)
      },
    }
  }

  if (hasDg) {
    return createDeepgramAdapter({
      apiKey: dg as string,
      ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    })
  }
  return createWhisperAdapter({
    apiKey: oa as string,
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
  })
}

/** Confidence threshold below which the host MUST force a HITL confirm
 *  even if the surface would otherwise allow batch-submit. The auto-submit
 *  invariant in ADR-0202 means this threshold is the floor — surfaces
 *  may raise it but never lower it. */
export const SOFT_CONFIDENCE_FLOOR = 0.5

/** True if the transcript's confidence is so low the surface MUST force
 *  the user to confirm before any send. Pairs with `HELL-S-11`. */
export const requiresExtraConfirm = (t: Pick<Transcript, "confidence">): boolean =>
  !Number.isFinite(t.confidence) || t.confidence < SOFT_CONFIDENCE_FLOOR
