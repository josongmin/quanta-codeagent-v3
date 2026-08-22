/**
 * Headless deterministic multi-modal embedder — ADR-0276 (sibling of
 * ADR-0261 headless stub). Same input yields byte-identical output.
 * Used by hellgate and any path that needs a `MultiModalEmbedder`
 * without a network or API key.
 *
 * Algorithm:
 *   text:        seed = djb2(text)
 *   image/audio: seed = djb2(mime + ":" + hex(first-N-bytes))
 *   PRNG: Mulberry32 → dim floats in [-1, 1].
 * Pure (no clock, no PRNG of its own — the seed is content-addressed).
 */
import { err, ok, type Result } from "@/shared"
import type { MultiModalEmbedder } from "./port"
import type { EmbedResult, MMCapabilities, MMEmbedError, MultiModalInput } from "./types"

const DEFAULT_DIM = 1024
const DEFAULT_MAX_IMAGE = 8 * 1024 * 1024 // 8 MiB
const DEFAULT_MAX_AUDIO = 16 * 1024 * 1024 // 16 MiB
const HASH_PREFIX_BYTES = 1024 // first 1 KiB of bytes feeds the hash

export interface HeadlessMmOptions {
  readonly dim?: number
  readonly modelTag?: string
  readonly maxImageBytes?: number
  readonly maxAudioBytes?: number
}

/** Bitwise djb2 — stable, branch-free, no allocations. */
const djb2 = (s: string): number => {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

/** Mulberry32 PRNG — single-state, well-distributed, fast. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const bytesToHex = (b: Uint8Array, limit: number): string => {
  const n = Math.min(b.length, limit)
  let s = ""
  for (let i = 0; i < n; i += 1) {
    const v = b[i] ?? 0
    s += v.toString(16).padStart(2, "0")
  }
  return s
}

const synthVector = (seedStr: string, dim: number): number[] => {
  const rng = mulberry32(djb2(seedStr))
  const v = new Array<number>(dim)
  for (let i = 0; i < dim; i += 1) v[i] = rng() * 2 - 1
  return v
}

const seedFor = (input: MultiModalInput): string => {
  switch (input.kind) {
    case "text":
      return `text:${input.text}`
    case "image":
      return `image:${input.blob.mime}:${bytesToHex(input.blob.bytes, HASH_PREFIX_BYTES)}`
    case "audio":
      return `audio:${input.blob.mime}:${bytesToHex(input.blob.bytes, HASH_PREFIX_BYTES)}`
  }
}

const validateInput = (
  input: MultiModalInput,
  maxImage: number,
  maxAudio: number,
): MMEmbedError | null => {
  if (input.kind === "text") {
    if (input.text.length === 0) return { kind: "empty-input" }
    return null
  }
  if (input.kind === "image") {
    if (input.blob.bytes.length === 0) return { kind: "empty-input" }
    if (input.blob.bytes.length > maxImage) {
      return { kind: "image-too-large", bytes: input.blob.bytes.length, cap: maxImage }
    }
    return null
  }
  // audio
  if (input.blob.bytes.length === 0) return { kind: "empty-input" }
  if (input.blob.bytes.length > maxAudio) {
    return { kind: "audio-too-large", bytes: input.blob.bytes.length, cap: maxAudio }
  }
  return null
}

export const createHeadlessMmEmbedder = (opts: HeadlessMmOptions = {}): MultiModalEmbedder => {
  const dim = opts.dim ?? DEFAULT_DIM
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE
  const maxAudioBytes = opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO
  const modelTag = opts.modelTag ?? `headless-mm:dim-${dim}`

  const caps: MMCapabilities = {
    dim,
    supportedModalities: ["text", "image", "audio"],
    maxImageBytes,
    maxAudioBytes,
    modelTag,
  }

  return {
    async embed(
      input: MultiModalInput,
      _opts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, MMEmbedError>> {
      const bad = validateInput(input, maxImageBytes, maxAudioBytes)
      if (bad !== null) return err(bad)
      const vec = synthVector(seedFor(input), dim)
      return ok({ vectors: [vec], modelTag })
    },
    async capabilities(): Promise<MMCapabilities> {
      return caps
    },
  }
}
