/**
 * Deterministic headless `Embedder` for tests (ADR-0254).
 *
 * Maps a text into a fixed-dim L2-normalised vector using:
 *
 *   1. A Bernstein-style (djb2-shaped) hash of the input text gives the
 *      32-bit seed.
 *   2. Mulberry32 is run `dim` times, with a coordinate-mixed seed
 *      `(seed + i * 0x9E3779B9)` per axis (0x9E3779B9 = 2^32 / φ —
 *      Knuth's golden-ratio multiplier; standard fast hashing constant,
 *      NOT invented).
 *   3. Each raw 32-bit output is mapped into the interval `[-1, 1]`.
 *   4. The vector is L2-normalised so cosine similarity stays in
 *      `[-1, 1]` regardless of dim.
 *
 * The mapping is **deterministic** — same text ⇒ byte-identical vector
 * — but NOT semantic: two texts that mean the same thing produce
 * uncorrelated vectors. Tests that need a semantic-similarity signal must
 * inject a fake embedder with hand-crafted vectors (the hellgate's
 * HELL-SS-05 case does exactly that).
 *
 * No I/O, no clock, safe to use anywhere in `bun test`.
 */

import { err, ok, type Result } from "@/shared"
import type { Embedder, EmbedError } from "./embed-port"
import type { EmbeddingVector } from "./types"

export interface HeadlessEmbedderOptions {
  /** Output dimension. Defaults to 64. Must be a positive integer. */
  readonly dim?: number
}

const DEFAULT_DIM = 64
/** 2^32 / φ — Knuth's golden-ratio hash multiplier. Standard, not invented. */
const PHI_MIX = 0x9e3779b9

/** Bernstein djb2-shaped string hash → unsigned 32-bit seed. */
const djb2 = (text: string): number => {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    // ((h << 5) + h) + ch  ===  h * 33 + ch
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  // Force into unsigned 32-bit range.
  return h >>> 0
}

/** Mulberry32 PRNG — public domain. Returns the next uint32. */
const mulberry32u32 = (seed: number): number => {
  let s = (seed + 0x6d2b79f5) | 0
  s = Math.imul(s ^ (s >>> 15), s | 1)
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61)
  return (s ^ (s >>> 14)) >>> 0
}

/** Build a deterministic headless embedder. */
export const createHeadlessEmbedder = (options?: HeadlessEmbedderOptions): Embedder => {
  const dim = options?.dim ?? DEFAULT_DIM
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`createHeadlessEmbedder: dim must be a positive integer (got ${dim})`)
  }

  const embed = async (text: string): Promise<Result<EmbeddingVector, EmbedError>> => {
    if (text === "") return err({ kind: "empty-text" })
    const seed = djb2(text)
    const raw = new Array<number>(dim)
    let sqsum = 0
    for (let i = 0; i < dim; i++) {
      const r = mulberry32u32((seed + Math.imul(i, PHI_MIX)) | 0)
      // Map uint32 → [-1, 1)
      const v = (r / 0xffffffff) * 2 - 1
      raw[i] = v
      sqsum += v * v
    }
    const norm = Math.sqrt(sqsum)
    if (norm === 0) {
      // Astronomically improbable but typed: return the raw vector unchanged.
      return ok(raw)
    }
    const out = new Array<number>(dim)
    for (let i = 0; i < dim; i++) out[i] = (raw[i] ?? 0) / norm
    return ok(out)
  }

  return {
    embed,
    dim: () => dim,
  }
}
