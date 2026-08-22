/**
 * Hellgate — Speech-to-Text adapters + registry (ADR-0202).
 *
 * 13 cases pinning the STT primitive contract. All adapters use an
 * INJECTED `fetchFn` so no real network call happens.
 */

import { describe, expect, test } from "bun:test"
import {
  createDeepgramAdapter,
  createSttFromEnv,
  createWhisperAdapter,
  type FetchLike,
  headlessSpeechToText,
  requiresExtraConfirm,
  selectSttAdapter,
} from "@/media/stt"
import type { AudioBlob } from "@/media/voice"

const wavBlob = (size = 16): AudioBlob => ({
  mime: "audio/wav",
  bytes: new Uint8Array(size),
  durationMs: 1000,
})

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

const fakeFetch = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  fn: FetchLike
  calls: { url: string; init?: RequestInit }[]
} => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn: FetchLike = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, ...(init !== undefined ? { init } : {}) })
    return responder(url, init)
  }
  return { fn, calls }
}

describe("STT hellgate (ADR-0202)", () => {
  test("HELL-S-01: deepgram parses transcript + confidence from happy-path body", async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse(200, {
        results: {
          channels: [{ alternatives: [{ transcript: "hello world", confidence: 0.93 }] }],
        },
      }),
    )
    const port = createDeepgramAdapter({ apiKey: "DG_KEY", fetchFn: fn })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.text).toBe("hello world")
      expect(r.value.confidence).toBeCloseTo(0.93, 5)
    }
    expect(calls[0]?.url).toContain("api.deepgram.com")
    const auth = (calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization
    expect(auth).toBe("Token DG_KEY")
    const ct = (calls[0]?.init?.headers as Record<string, string> | undefined)?.["Content-Type"]
    expect(ct).toBe("audio/wav")
  })

  test("HELL-S-02: deepgram 401 → auth-failed", async () => {
    const { fn } = fakeFetch(() => new Response("nope", { status: 401 }))
    const port = createDeepgramAdapter({ apiKey: "bad", fetchFn: fn })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("auth-failed")
      if (r.error.kind === "auth-failed") expect(r.error.status).toBe(401)
    }
  })

  test("HELL-S-03: deepgram 429 → rate-limited (with retryAfterMs when header present)", async () => {
    const { fn } = fakeFetch(
      () => new Response("slow", { status: 429, headers: { "retry-after": "12" } }),
    )
    const port = createDeepgramAdapter({ apiKey: "ok", fetchFn: fn })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("rate-limited")
      if (r.error.kind === "rate-limited") {
        expect(r.error.status).toBe(429)
        expect(r.error.retryAfterMs).toBe(12000)
      }
    }
  })

  test("HELL-S-04: deepgram empty alternatives → no-transcription", async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse(200, { results: { channels: [{ alternatives: [] }] } }),
    )
    const port = createDeepgramAdapter({ apiKey: "ok", fetchFn: fn })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("no-transcription")

    // also: empty transcript string → no-transcription
    const { fn: fn2 } = fakeFetch(() =>
      jsonResponse(200, {
        results: { channels: [{ alternatives: [{ transcript: "", confidence: 0.9 }] }] },
      }),
    )
    const port2 = createDeepgramAdapter({ apiKey: "ok", fetchFn: fn2 })
    const r2 = await port2.transcribe(wavBlob())
    expect(r2.ok).toBe(false)
  })

  test("HELL-S-05: whisper parses text + sets confidence=1.0 + carries language", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(200, { text: "salut", language: "fr" }))
    const port = createWhisperAdapter({ apiKey: "OA_KEY", fetchFn: fn })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.text).toBe("salut")
      expect(r.value.confidence).toBe(1.0)
      expect(r.value.languageHint).toBe("fr")
    }
    const auth = (calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization
    expect(auth).toBe("Bearer OA_KEY")
    expect(calls[0]?.url).toContain("openai.com/v1/audio/transcriptions")
    // FormData body — model + response_format fields wired
    const body = calls[0]?.init?.body as FormData | undefined
    expect(body).toBeDefined()
    if (body !== undefined) {
      expect(body.get("model")).toBe("whisper-1")
      expect(body.get("response_format")).toBe("verbose_json")
    }
  })

  test("HELL-S-06: whisper 4xx → transcription-failed with status", async () => {
    const { fn } = fakeFetch(() => new Response("bad input", { status: 400 }))
    const port = createWhisperAdapter({ apiKey: "ok", fetchFn: fn })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("transcription-failed")
      if (r.error.kind === "transcription-failed") expect(r.error.status).toBe(400)
    }
  })

  test("HELL-S-07: registry selects deepgram when DEEPGRAM_API_KEY is set", () => {
    expect(selectSttAdapter({ DEEPGRAM_API_KEY: "x" })).toBe("deepgram")
    expect(selectSttAdapter({ DEEPGRAM_API_KEY: "x", OPENAI_API_KEY: "y" })).toBe("deepgram")
  })

  test("HELL-S-08: registry selects whisper when only OPENAI_API_KEY is set", () => {
    expect(selectSttAdapter({ OPENAI_API_KEY: "y" })).toBe("whisper")
  })

  test("HELL-S-09: registry selects headless-stub when neither key is set", async () => {
    expect(selectSttAdapter({})).toBe("headless-stub")
    const port = createSttFromEnv({ env: {} })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.text).toBe("test transcription")
      expect(r.value.confidence).toBe(1.0)
    }
    // headless port also reachable directly
    const port2 = headlessSpeechToText()
    const r2 = await port2.transcribe(wavBlob())
    expect(r2.ok).toBe(true)
  })

  test("HELL-S-10: registry with both keys + fallbackOnError retries whisper on deepgram failure", async () => {
    let call = 0
    const fn: FetchLike = async (input) => {
      call += 1
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("deepgram")) {
        return new Response("nope", { status: 500 })
      }
      // whisper success on second call
      return jsonResponse(200, { text: "fell back", language: "en" })
    }
    const port = createSttFromEnv({
      env: { DEEPGRAM_API_KEY: "dg", OPENAI_API_KEY: "oa" },
      fetchFn: fn,
      fallbackOnError: true,
    })
    const r = await port.transcribe(wavBlob())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.text).toBe("fell back")
    expect(call).toBe(2)
  })

  test("HELL-S-11: low confidence (<0.5) forces extra confirm", () => {
    expect(requiresExtraConfirm({ confidence: 0.49 })).toBe(true)
    expect(requiresExtraConfirm({ confidence: 0.5 })).toBe(false)
    expect(requiresExtraConfirm({ confidence: 0.99 })).toBe(false)
    expect(requiresExtraConfirm({ confidence: Number.NaN })).toBe(true)
  })

  test("HELL-S-12: non-wav/mp3 mime → unsupported-mime Err without fetch", async () => {
    let calls = 0
    const fn: FetchLike = async () => {
      calls += 1
      return new Response("{}", { status: 200 })
    }
    const port = createDeepgramAdapter({ apiKey: "ok", fetchFn: fn })
    const r = await port.transcribe({
      mime: "audio/ogg" as unknown as "audio/wav",
      bytes: new Uint8Array(8),
      durationMs: 1000,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unsupported-mime")
    expect(calls).toBe(0)
  })

  test("HELL-S-13: 0-byte blob → empty-audio Err without fetch", async () => {
    let calls = 0
    const fn: FetchLike = async () => {
      calls += 1
      return new Response("{}", { status: 200 })
    }
    const port = createWhisperAdapter({ apiKey: "ok", fetchFn: fn })
    const r = await port.transcribe(wavBlob(0))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("empty-audio")
    expect(calls).toBe(0)
  })
})
