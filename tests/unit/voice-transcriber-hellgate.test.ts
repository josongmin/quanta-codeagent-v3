/**
 * Hellgate — TranscriberPort (ADR-0208).
 *
 * 12 cases pinning the transcriber adapters (deepgram + openai-whisper
 * + local-whisper) against their typed-error contract. All adapters
 * return `Result<…>` — no thrown errors — so the slash command can
 * exhaustively branch on `kind`.
 *
 *  HELL-VT-01: deepgram 200 with utterances ⇒ text + segments + language
 *  HELL-VT-02: deepgram 401 ⇒ auth-failed
 *  HELL-VT-03: deepgram 429 with retry-after ⇒ rate-limited{retryAfterMs}
 *  HELL-VT-04: deepgram 500 ⇒ transcription-failed
 *  HELL-VT-05: whisper 200 verbose_json ⇒ text + segments + language
 *  HELL-VT-06: whisper 4xx ⇒ transcription-failed
 *  HELL-VT-07: whisper timeout ⇒ timeout{elapsedMs}
 *  HELL-VT-08: empty audio ⇒ empty-audio (both adapters)
 *  HELL-VT-09: unsupported format ⇒ unsupported-format (both adapters)
 *  HELL-VT-10: abort signal pre-call ⇒ aborted (both adapters)
 *  HELL-VT-11: language passed through to query/form (deepgram + whisper)
 *  HELL-VT-12: local-whisper binary-missing ⇒ transcription-failed
 */

import { describe, expect, test } from "bun:test"
import {
  createDeepgramTranscriber,
  createLocalWhisperTranscriber,
  createOpenAIWhisperTranscriber,
  type FetchLike,
  type WhisperBinaryChild,
  type WhisperBinarySpawner,
  type WhisperFileSystem,
} from "@/voice"

const wavBytes = (n: number): Uint8Array => {
  const a = new Uint8Array(n)
  // RIFF header so consumers that sniff would accept
  a[0] = 0x52
  a[1] = 0x49
  a[2] = 0x46
  a[3] = 0x46
  return a
}

const okJson = (body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })

const errStatus = (status: number, body?: string, headers?: Record<string, string>): Response =>
  new Response(body ?? "", { status, headers: headers ?? {} })

describe("voice-transcriber hellgate (ADR-0208)", () => {
  test("HELL-VT-01: deepgram 200 with utterances ⇒ text + segments + language", async () => {
    const fakeFetch: FetchLike = async (_input, _init) =>
      okJson({
        metadata: { detected_language: "en" },
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "hello world",
                  confidence: 0.97,
                  words: [
                    { word: "hello", punctuated_word: "hello,", start: 0, end: 0.5 },
                    { word: "world", punctuated_word: "world.", start: 0.5, end: 1.0 },
                  ],
                },
              ],
            },
          ],
          utterances: [{ transcript: "hello world", start: 0, end: 1 }],
        },
      })
    const t = createDeepgramTranscriber({ apiKey: "k", fetchFn: fakeFetch })
    const r = await t.transcribe({ audio: wavBytes(16), format: "wav" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.text).toBe("hello world")
    expect(r.value.language).toBe("en")
    expect(r.value.segments?.length).toBe(1)
    expect(r.value.segments?.[0]?.startMs).toBe(0)
    expect(r.value.segments?.[0]?.endMs).toBe(1000)
  })

  test("HELL-VT-02: deepgram 401 ⇒ auth-failed", async () => {
    const t = createDeepgramTranscriber({
      apiKey: "bad",
      fetchFn: async () => errStatus(401, "unauthorized"),
    })
    const r = await t.transcribe({ audio: wavBytes(8), format: "wav" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("auth-failed")
      if (r.error.kind === "auth-failed") expect(r.error.status).toBe(401)
    }
  })

  test("HELL-VT-03: deepgram 429 with retry-after ⇒ rate-limited{retryAfterMs}", async () => {
    const t = createDeepgramTranscriber({
      apiKey: "k",
      fetchFn: async () => errStatus(429, "slow down", { "retry-after": "2" }),
    })
    const r = await t.transcribe({ audio: wavBytes(8), format: "wav" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("rate-limited")
      if (r.error.kind === "rate-limited") {
        expect(r.error.status).toBe(429)
        expect(r.error.retryAfterMs).toBe(2000)
      }
    }
  })

  test("HELL-VT-04: deepgram 500 ⇒ transcription-failed", async () => {
    const t = createDeepgramTranscriber({
      apiKey: "k",
      fetchFn: async () => errStatus(500, "boom"),
    })
    const r = await t.transcribe({ audio: wavBytes(8), format: "wav" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("transcription-failed")
      if (r.error.kind === "transcription-failed") expect(r.error.status).toBe(500)
    }
  })

  test("HELL-VT-05: whisper 200 verbose_json ⇒ text + segments + language", async () => {
    const t = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: async () =>
        okJson({
          text: "hi there",
          language: "english",
          segments: [
            { text: "hi", start: 0, end: 0.3 },
            { text: "there", start: 0.3, end: 0.7 },
          ],
        }),
    })
    const r = await t.transcribe({ audio: wavBytes(16), format: "wav" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.text).toBe("hi there")
    expect(r.value.language).toBe("english")
    expect(r.value.segments?.length).toBe(2)
    expect(r.value.segments?.[1]?.startMs).toBe(300)
    expect(r.value.segments?.[1]?.endMs).toBe(700)
  })

  test("HELL-VT-06: whisper 4xx ⇒ transcription-failed", async () => {
    const t = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: async () => errStatus(400, "bad request"),
    })
    const r = await t.transcribe({ audio: wavBytes(8), format: "wav" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("transcription-failed")
      if (r.error.kind === "transcription-failed") expect(r.error.status).toBe(400)
    }
  })

  test("HELL-VT-07: whisper timeout ⇒ timeout{elapsedMs}", async () => {
    // fetchFn that respects the AbortSignal — rejects with AbortError when
    // the chained signal fires (timeout aborts after 5 ms).
    const fakeFetch: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined
        if (sig === undefined) return
        const onAbort = (): void => {
          const e = new Error("AbortError")
          e.name = "AbortError"
          reject(e)
        }
        if (sig.aborted) onAbort()
        else sig.addEventListener("abort", onAbort, { once: true })
      })
    const t = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: fakeFetch,
      timeoutMs: 5,
    })
    const r = await t.transcribe({ audio: wavBytes(8), format: "wav" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout")
      if (r.error.kind === "timeout") expect(r.error.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })

  test("HELL-VT-08: empty audio ⇒ empty-audio (both adapters)", async () => {
    const dg = createDeepgramTranscriber({
      apiKey: "k",
      fetchFn: async () => okJson({}),
    })
    const w = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: async () => okJson({}),
    })
    const dr = await dg.transcribe({ audio: new Uint8Array(0), format: "wav" })
    expect(dr.ok).toBe(false)
    if (!dr.ok) expect(dr.error.kind).toBe("empty-audio")
    const wr = await w.transcribe({ audio: new Uint8Array(0), format: "wav" })
    expect(wr.ok).toBe(false)
    if (!wr.ok) expect(wr.error.kind).toBe("empty-audio")
  })

  test("HELL-VT-09: unsupported format ⇒ unsupported-format (both adapters)", async () => {
    const dg = createDeepgramTranscriber({
      apiKey: "k",
      fetchFn: async () => okJson({}),
    })
    const w = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: async () => okJson({}),
    })
    const bad = "mp3" as unknown as "wav"
    const dr = await dg.transcribe({ audio: wavBytes(8), format: bad })
    expect(dr.ok).toBe(false)
    if (!dr.ok) {
      expect(dr.error.kind).toBe("unsupported-format")
      if (dr.error.kind === "unsupported-format") expect(dr.error.format).toBe("mp3")
    }
    const wr = await w.transcribe({ audio: wavBytes(8), format: bad })
    expect(wr.ok).toBe(false)
    if (!wr.ok) expect(wr.error.kind).toBe("unsupported-format")
  })

  test("HELL-VT-10: abort signal pre-call ⇒ aborted (both adapters)", async () => {
    let fetchCalls = 0
    const dg = createDeepgramTranscriber({
      apiKey: "k",
      fetchFn: async () => {
        fetchCalls += 1
        return okJson({})
      },
    })
    const w = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: async () => {
        fetchCalls += 1
        return okJson({})
      },
    })
    const ac = new AbortController()
    ac.abort()
    const dr = await dg.transcribe({ audio: wavBytes(8), format: "wav", signal: ac.signal })
    const wr = await w.transcribe({ audio: wavBytes(8), format: "wav", signal: ac.signal })
    expect(dr.ok).toBe(false)
    expect(wr.ok).toBe(false)
    if (!dr.ok) expect(dr.error.kind).toBe("aborted")
    if (!wr.ok) expect(wr.error.kind).toBe("aborted")
    expect(fetchCalls).toBe(0)
  })

  test("HELL-VT-11: language passed through to query/form (deepgram + whisper)", async () => {
    let dgUrl = ""
    const dg = createDeepgramTranscriber({
      apiKey: "k",
      fetchFn: async (input) => {
        dgUrl = typeof input === "string" ? input : input.toString()
        return okJson({
          metadata: { detected_language: "ko" },
          results: {
            channels: [{ alternatives: [{ transcript: "안녕", confidence: 0.9 }] }],
          },
        })
      },
    })
    const dr = await dg.transcribe({ audio: wavBytes(8), format: "wav", language: "ko" })
    expect(dr.ok).toBe(true)
    expect(dgUrl).toContain("language=ko")

    let whisperFormHadLang = false
    const w = createOpenAIWhisperTranscriber({
      apiKey: "k",
      fetchFn: async (_input, init) => {
        const body = init?.body as FormData | undefined
        if (body !== undefined) {
          const v = body.get("language")
          whisperFormHadLang = typeof v === "string" && v === "ko"
        }
        return okJson({ text: "안녕", language: "korean" })
      },
    })
    const wr = await w.transcribe({ audio: wavBytes(8), format: "wav", language: "ko" })
    expect(wr.ok).toBe(true)
    expect(whisperFormHadLang).toBe(true)
  })

  test("HELL-VT-12: local-whisper binary-missing ⇒ transcription-failed", async () => {
    const spawner: WhisperBinarySpawner = {
      which: () => null,
      spawn: () => {
        throw new Error("should not spawn")
      },
    }
    const fs: WhisperFileSystem = {
      mkdtemp: async () => "/tmp/quanta-voice-test",
      writeFile: async () => {},
      readFile: async () => "",
      rm: async () => {},
    }
    const lw = createLocalWhisperTranscriber({ spawner, fs })
    const r = await lw.transcribe({ audio: wavBytes(8), format: "wav" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("transcription-failed")
      if (r.error.kind === "transcription-failed") {
        expect(r.error.degradeReason.toLowerCase()).toContain("whisper-cpp")
      }
    }
  })

  test("HELL-VT-13: local-whisper happy-path reads .txt output", async () => {
    const spawnCalls: (readonly string[])[] = []
    const child: WhisperBinaryChild = {
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close()
        },
      }),
      exited: Promise.resolve(0),
      kill() {},
    }
    const spawner: WhisperBinarySpawner = {
      which: () => "/usr/local/bin/whisper-cpp",
      spawn: (argv) => {
        spawnCalls.push(argv)
        return child
      },
    }
    const written: Record<string, Uint8Array> = {}
    const fs: WhisperFileSystem = {
      mkdtemp: async () => "/tmp/quanta-voice-x",
      writeFile: async (p, d) => {
        written[p] = d
      },
      readFile: async (p) => {
        if (p.endsWith(".txt")) return "hello from local whisper"
        throw new Error("unknown read")
      },
      rm: async () => {},
    }
    const lw = createLocalWhisperTranscriber({ spawner, fs, modelPath: "/m/ggml.bin" })
    const r = await lw.transcribe({ audio: wavBytes(16), format: "wav", language: "en" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.text).toBe("hello from local whisper")
    }
    expect(spawnCalls.length).toBe(1)
    const argv = spawnCalls[0] as readonly string[]
    expect(argv).toContain("-m")
    expect(argv).toContain("/m/ggml.bin")
    expect(argv).toContain("-l")
    expect(argv).toContain("en")
  })
})
