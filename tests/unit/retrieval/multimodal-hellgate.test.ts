/**
 * ADR-0276 — Multi-modal embedding MVP HELLGATE.
 *
 * 18 adversarial cases across 4 sections:
 *   A. Input shape           — HELL-MM-01..08
 *   B. Voyage adapter        — HELL-MM-09..11
 *   C. CLIP adapter          — HELL-MM-12..13
 *   D. Headless / registry / closed-shape — HELL-MM-14..18
 *
 * Every adapter is hit through its injected `fetch` — zero network.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_MODALITIES,
  type AudioBlob,
  type ClipRestOptions,
  createClipRestEmbedder,
  createHeadlessMmEmbedder,
  createMultiModalEmbedderFromEnv,
  createVoyageMultiModalEmbedder,
  type ImageBlob,
  isMmEmbedProvider,
  MM_EMBED_ERROR_KINDS,
  MM_EMBED_PROVIDERS,
  type MMEmbedError,
  type MultiModalInput,
} from "@/retrieval/multimodal"

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const textResponse = (status: number, body: string): Response => new Response(body, { status })

type FetchCall = { url: string; method: string; body: unknown }

const recorder = (reply: (req: FetchCall) => Response) => {
  const calls: FetchCall[] = []
  return {
    calls,
    fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url,
        method: (init?.method as string | undefined) ?? "GET",
        body: init?.body ?? null,
      })
      return reply({
        url,
        method: (init?.method as string | undefined) ?? "GET",
        body: init?.body ?? null,
      })
    },
  }
}

const png = (n: number): ImageBlob => ({
  mime: "image/png",
  bytes: new Uint8Array(n).fill(0x89),
})

const wav = (n: number): AudioBlob => ({
  mime: "audio/wav",
  bytes: new Uint8Array(n).fill(0x52),
})

const voyageVector = (dim: number): number[] => Array.from({ length: dim }, (_, i) => i / dim)

const voyageOk = (dim = 1024): Response =>
  jsonResponse(200, {
    data: [{ embedding: voyageVector(dim) }],
    usage: { total_tokens: 42 },
  })

const clipOk = (dim = 512): Response => jsonResponse(200, { embedding: voyageVector(dim) })

// ──────────────────────────────────────────────────────────────────────────
// A. Input shape
// ──────────────────────────────────────────────────────────────────────────

describe("ADR-0276 hellgate — input shape", () => {
  test("HELL-MM-01: text input → vector via headless", async () => {
    const e = createHeadlessMmEmbedder({ dim: 8 })
    const r = await e.embed({ kind: "text", text: "hello multimodal" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors).toHaveLength(1)
    expect(r.value.vectors[0]).toHaveLength(8)
  })

  test("HELL-MM-02: image input → vector with exact dim", async () => {
    const e = createHeadlessMmEmbedder({ dim: 32 })
    const r = await e.embed({ kind: "image", blob: png(2048) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors).toHaveLength(1)
    expect(r.value.vectors[0]).toHaveLength(32)
  })

  test("HELL-MM-03: audio input → vector via headless", async () => {
    const e = createHeadlessMmEmbedder({ dim: 16 })
    const r = await e.embed({ kind: "audio", blob: wav(8192) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors[0]).toHaveLength(16)
  })

  test("HELL-MM-04: 3-arm modality exhaustive switch", () => {
    // Authoring-time exhaustive check via assertNever-style. If a 4th arm
    // appears, this function fails to type-check.
    const f = (i: MultiModalInput): string => {
      switch (i.kind) {
        case "text":
          return "t"
        case "image":
          return "i"
        case "audio":
          return "a"
      }
    }
    expect(f({ kind: "text", text: "x" })).toBe("t")
    expect(f({ kind: "image", blob: png(1) })).toBe("i")
    expect(f({ kind: "audio", blob: wav(1) })).toBe("a")
    expect(ALL_MODALITIES).toEqual(["text", "image", "audio"])
  })

  test("HELL-MM-05: image > maxImageBytes → Err(image-too-large)", async () => {
    const e = createHeadlessMmEmbedder({ maxImageBytes: 1024 })
    const r = await e.embed({ kind: "image", blob: png(2048) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("image-too-large")
    if (r.error.kind !== "image-too-large") return
    expect(r.error.bytes).toBe(2048)
    expect(r.error.cap).toBe(1024)
  })

  test("HELL-MM-06: audio > maxAudioBytes → Err(audio-too-large)", async () => {
    const e = createHeadlessMmEmbedder({ maxAudioBytes: 4096 })
    const r = await e.embed({ kind: "audio", blob: wav(8192) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("audio-too-large")
    if (r.error.kind !== "audio-too-large") return
    expect(r.error.bytes).toBe(8192)
    expect(r.error.cap).toBe(4096)
  })

  test("HELL-MM-07: unsupported mime → Err(unsupported-mime)", async () => {
    const rec = recorder(() => clipOk())
    const e = createClipRestEmbedder({
      endpoint: "https://clip.test/embed",
      fetchImpl: rec.fetchImpl,
    })
    const r = await e.embed({
      kind: "image",
      blob: { mime: "image/exotic-raw", bytes: new Uint8Array(8) },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("unsupported-mime")
    if (r.error.kind !== "unsupported-mime") return
    expect(r.error.mime).toBe("image/exotic-raw")
    expect(rec.calls).toHaveLength(0) // never touched the wire
  })

  test("HELL-MM-08: image 0-byte → Err(empty-input)", async () => {
    const e = createHeadlessMmEmbedder()
    const r = await e.embed({
      kind: "image",
      blob: { mime: "image/png", bytes: new Uint8Array(0) },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("empty-input")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// B. Voyage adapter
// ──────────────────────────────────────────────────────────────────────────

describe("ADR-0276 hellgate — Voyage adapter", () => {
  test("HELL-MM-09: voyage mock fetch success (image)", async () => {
    const rec = recorder(() => voyageOk(1024))
    const e = createVoyageMultiModalEmbedder({
      apiKey: "sk-test",
      fetchImpl: rec.fetchImpl,
    })
    const r = await e.embed({ kind: "image", blob: png(512) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.vectors[0]).toHaveLength(1024)
    expect(r.value.modelTag).toBe("voyage:voyage-multimodal-3")
    expect(r.value.tokenCount).toBe(42)
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.url).toBe("https://api.voyageai.com/v1/multimodalembeddings")
    // body present + JSON (sanity)
    const body = rec.calls[0]?.body as string
    expect(typeof body).toBe("string")
    const parsed = JSON.parse(body) as {
      model: string
      inputs: Array<{ content: Array<{ type: string }> }>
    }
    expect(parsed.model).toBe("voyage-multimodal-3")
    expect(parsed.inputs[0]?.content[0]?.type).toBe("image_base64")
  })

  test("HELL-MM-10: voyage 4xx → Err(missing-api-key) (auth-failed alias)", async () => {
    const rec = recorder(() => textResponse(401, "unauthorized"))
    const e = createVoyageMultiModalEmbedder({
      apiKey: "sk-bad",
      fetchImpl: rec.fetchImpl,
    })
    const r = await e.embed({ kind: "text", text: "ping" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // 4xx folds into missing-api-key (the user-actionable arm).
    expect(r.error.kind).toBe("missing-api-key")
    if (r.error.kind !== "missing-api-key") return
    expect(r.error.provider).toBe("voyage")
  })

  test("HELL-MM-11: voyage 429 → throws rate-limited", async () => {
    const rec = recorder(() => textResponse(429, "slow down"))
    const e = createVoyageMultiModalEmbedder({
      apiKey: "sk-test",
      fetchImpl: rec.fetchImpl,
    })
    let caught: Error | null = null
    try {
      await e.embed({ kind: "text", text: "ping" })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught?.message).toBe("rate-limited")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// C. CLIP adapter
// ──────────────────────────────────────────────────────────────────────────

describe("ADR-0276 hellgate — CLIP adapter", () => {
  test("HELL-MM-12: clip mock fetch success (text + image + audio)", async () => {
    const rec = recorder(() => clipOk(64))
    const e = createClipRestEmbedder({
      endpoint: "https://clip.test/v1/embed",
      dim: 64,
      fetchImpl: rec.fetchImpl,
    })
    const r1 = await e.embed({ kind: "text", text: "abc" })
    const r2 = await e.embed({ kind: "image", blob: png(64) })
    const r3 = await e.embed({ kind: "audio", blob: wav(64) })
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value.vectors[0]).toHaveLength(64)
      expect(r.value.modelTag).toBe("clip:rest")
    }
    expect(rec.calls).toHaveLength(3)
    // multipart body bytes present + boundary in content-type-equivalent header
    expect(rec.calls[0]?.body).toBeInstanceOf(Uint8Array)
  })

  test("HELL-MM-13: clip endpoint missing → Err(endpoint-missing)", async () => {
    const rec = recorder(() => clipOk())
    const opts: ClipRestOptions = {
      // endpoint deliberately undefined
      fetchImpl: rec.fetchImpl,
    }
    const e = createClipRestEmbedder(opts)
    const r = await e.embed({ kind: "text", text: "x" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe("endpoint-missing")
    expect(rec.calls).toHaveLength(0)

    // also: empty-string endpoint
    const e2 = createClipRestEmbedder({ endpoint: "", fetchImpl: rec.fetchImpl })
    const r2 = await e2.embed({ kind: "text", text: "x" })
    expect(r2.ok).toBe(false)
    if (r2.ok) return
    expect(r2.error.kind).toBe("endpoint-missing")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// D. Headless / registry / closed-shape
// ──────────────────────────────────────────────────────────────────────────

describe("ADR-0276 hellgate — headless / registry / closed-shape", () => {
  test("HELL-MM-14: headless deterministic — same input → same vector", async () => {
    const e1 = createHeadlessMmEmbedder({ dim: 8 })
    const e2 = createHeadlessMmEmbedder({ dim: 8 })
    const inputT: MultiModalInput = { kind: "text", text: "stable-seed" }
    const inputI: MultiModalInput = { kind: "image", blob: png(256) }
    const inputA: MultiModalInput = { kind: "audio", blob: wav(256) }
    for (const inp of [inputT, inputI, inputA]) {
      const a = await e1.embed(inp)
      const b = await e2.embed(inp)
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(a.value.vectors[0]).toEqual(b.value.vectors[0])
    }
    // different input → different vector
    const x = await e1.embed({ kind: "text", text: "stable-seed" })
    const y = await e1.embed({ kind: "text", text: "different-seed" })
    if (!x.ok || !y.ok) throw new Error("unexpected err")
    expect(x.value.vectors[0]).not.toEqual(y.value.vectors[0])
  })

  test("HELL-MM-15: capabilities round-trip across adapters", async () => {
    const h = createHeadlessMmEmbedder({ dim: 256 })
    const v = createVoyageMultiModalEmbedder({ apiKey: "sk", dim: 1024 })
    const c = createClipRestEmbedder({ endpoint: "https://x", dim: 512 })
    const ch = await h.capabilities()
    const cv = await v.capabilities()
    const cc = await c.capabilities()
    expect(ch.dim).toBe(256)
    expect(cv.dim).toBe(1024)
    expect(cc.dim).toBe(512)
    expect(ch.supportedModalities).toEqual(["text", "image", "audio"])
    expect(cv.supportedModalities).toEqual(["text", "image"]) // voyage no audio
    expect(cc.supportedModalities).toEqual(["text", "image", "audio"])
    expect(ch.modelTag).toBe("headless-mm:dim-256")
    expect(cv.modelTag).toBe("voyage:voyage-multimodal-3")
    expect(cc.modelTag).toBe("clip:rest")
  })

  test("HELL-MM-16: registry env swap — voyage / clip / headless / unknown", () => {
    // headless: always constructible
    const eh = createMultiModalEmbedderFromEnv({ QUANTA_MM_EMBED: "headless" })
    expect(eh).not.toBeNull()

    // voyage: constructible (api-key check defers to embed())
    const ev = createMultiModalEmbedderFromEnv({
      QUANTA_MM_EMBED: "voyage",
      VOYAGE_API_KEY: "sk-from-env",
    })
    expect(ev).not.toBeNull()

    // clip: constructible (endpoint check defers to embed())
    const ec = createMultiModalEmbedderFromEnv({
      QUANTA_MM_EMBED: "clip",
      QUANTA_CLIP_ENDPOINT: "https://clip.test/embed",
    })
    expect(ec).not.toBeNull()

    // unknown / unset → null
    expect(createMultiModalEmbedderFromEnv({ QUANTA_MM_EMBED: "azure" })).toBeNull()
    expect(createMultiModalEmbedderFromEnv({})).toBeNull()

    // type-guard surface
    expect(isMmEmbedProvider("voyage")).toBe(true)
    expect(isMmEmbedProvider("clip")).toBe(true)
    expect(isMmEmbedProvider("headless")).toBe(true)
    expect(isMmEmbedProvider("azure")).toBe(false)
    expect(isMmEmbedProvider(undefined)).toBe(false)

    // canonical list
    expect([...MM_EMBED_PROVIDERS]).toEqual(["voyage", "clip", "headless"])
  })

  test("HELL-MM-17: MMEmbedError 6-arm closed exhaustive", () => {
    expect([...MM_EMBED_ERROR_KINDS]).toEqual([
      "missing-api-key",
      "endpoint-missing",
      "unsupported-mime",
      "image-too-large",
      "audio-too-large",
      "empty-input",
    ])
    // Exhaustive switch coverage — compile-time + runtime.
    const cover = (e: MMEmbedError): string => {
      switch (e.kind) {
        case "missing-api-key":
          return `mak:${e.provider}`
        case "endpoint-missing":
          return "em"
        case "unsupported-mime":
          return `um:${e.mime}`
        case "image-too-large":
          return `itl:${e.bytes}/${e.cap}`
        case "audio-too-large":
          return `atl:${e.bytes}/${e.cap}`
        case "empty-input":
          return "ei"
      }
    }
    expect(cover({ kind: "missing-api-key", provider: "voyage" })).toBe("mak:voyage")
    expect(cover({ kind: "endpoint-missing" })).toBe("em")
    expect(cover({ kind: "unsupported-mime", mime: "x/y" })).toBe("um:x/y")
    expect(cover({ kind: "image-too-large", bytes: 9, cap: 8 })).toBe("itl:9/8")
    expect(cover({ kind: "audio-too-large", bytes: 9, cap: 8 })).toBe("atl:9/8")
    expect(cover({ kind: "empty-input" })).toBe("ei")
  })

  test("HELL-MM-18: default-OFF — no registry construction without env", () => {
    // No env at all → registry returns null. No side effects, no fetch.
    const empty: Record<string, string> = {}
    expect(createMultiModalEmbedderFromEnv(empty)).toBeNull()
    // Setting only an API key (no provider) → still null.
    expect(
      createMultiModalEmbedderFromEnv({ VOYAGE_API_KEY: "sk-xxx" } as Record<string, string>),
    ).toBeNull()
    // Setting only an endpoint (no provider) → still null.
    expect(
      createMultiModalEmbedderFromEnv({
        QUANTA_CLIP_ENDPOINT: "https://clip.test",
      } as Record<string, string>),
    ).toBeNull()
  })
})
