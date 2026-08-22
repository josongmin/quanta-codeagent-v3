/**
 * Headless deterministic embedder — ADR-0261 (sibling of ADR-0254-style
 * stub). Same input string yields byte-identical output. Used by hellgate
 * and any code path that needs an `Embedder` without a network or API key.
 *
 * Algorithm: djb2 string hash → Mulberry32 PRNG seed → dim floats in [-1, 1].
 * Pure (no clock, no PRNG of its own — the seed is content-addressed).
 */
import { err, ok, type Result } from "@/shared"
import type { Embedder } from "./port"
import type { EmbedderCapabilities, EmbedError, EmbedResult } from "./types"

const DEFAULT_DIM = 1536
const DEFAULT_BATCH = 128
const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 // 32 KiB per input

export interface HeadlessStubOptions {
  readonly dim?: number
  readonly modelTag?: string
  readonly maxInputBytes?: number
  readonly batchSize?: number
}

/** Bitwise djb2 — stable, branch-free, no allocations. */
const djb2 = (s: string): number => {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return h >>> 0 // coerce to uint32
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

const synthVector = (input: string, dim: number): number[] => {
  const rng = mulberry32(djb2(input))
  const v = new Array<number>(dim)
  for (let i = 0; i < dim; i += 1) v[i] = rng() * 2 - 1
  return v
}

export const createHeadlessEmbedder = (opts: HeadlessStubOptions = {}): Embedder => {
  const dim = opts.dim ?? DEFAULT_DIM
  const modelTag = opts.modelTag ?? `headless:dim-${dim}`
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
  const batchSize = opts.batchSize ?? DEFAULT_BATCH

  const caps: EmbedderCapabilities = { dim, maxInputBytes, batchSize, modelTag }

  return {
    async embed(
      input: string | readonly string[],
      callOpts?: { readonly signal?: AbortSignal },
    ): Promise<Result<EmbedResult, EmbedError>> {
      if (callOpts?.signal?.aborted === true) return err({ kind: "aborted" })
      const items = typeof input === "string" ? [input] : input
      for (const s of items) {
        const bytes = Buffer.byteLength(s, "utf8")
        if (bytes > maxInputBytes) {
          return err({ kind: "input-too-large", bytes, cap: maxInputBytes })
        }
      }
      const vectors = items.map((s) => synthVector(s, dim))
      return ok({ vectors, modelTag })
    },
    async capabilities(): Promise<EmbedderCapabilities> {
      return caps
    },
  }
}
