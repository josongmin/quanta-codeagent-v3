/**
 * Token-bucket re-chunker — split a long text into fixed-size chunks with
 * sliding-window overlap, so downstream context windows can ingest big
 * documents without dropping middle content.
 *
 * Bucket sizes (in tokens, measured by the injected {@link TokenizerPort}):
 *   - `identity`     — no split; emit `[text]` unchanged
 *   - `small-600`    — 600 token windows
 *   - `medium-2400`  — 2400 token windows
 *   - `large-4000`   — 4000 token windows
 *
 * Overlap defaults to 10% — sliding-window standard from Karpukhin et al.
 * 2020 (DPR) + Lewis et al. 2020 (RAG). NOT invented. The overlap is the
 * number of tokens shared between adjacent chunks; with a 600-token bucket
 * and the default overlap, chunk `i+1` starts at token `i + 540`.
 *
 * Byte-deterministic for a fixed `tokenizer.count`. The function does NOT
 * tokenize the text itself — it walks the byte stream and asks the
 * tokenizer for the count of a prefix until the count reaches the bucket
 * size. This keeps the tokenizer port surface minimal (ISP — `count` only).
 */
import { RetrievalError } from "./types"

export type ChunkBucket = "identity" | "small-600" | "medium-2400" | "large-4000"

/** Closed port — caller's tokenizer (e.g. tiktoken, claude bpe, openai cl100k). */
export interface TokenizerPort {
  /** Token count for the input. Pure — same input ⇒ same output. */
  count(text: string): number
}

/** Bucket size table. The values match the bucket names. */
export const BUCKET_TOKENS: Readonly<Record<ChunkBucket, number>> = {
  identity: 0,
  "small-600": 600,
  "medium-2400": 2400,
  "large-4000": 4000,
}

/** Default sliding-window overlap ratio (DPR/RAG standard). */
export const DEFAULT_OVERLAP_RATIO = 0.1

export interface ChunkBucketOptions {
  bucket: ChunkBucket
  /** Overlap ratio in [0, 0.9]. Defaults to 0.10. */
  overlapRatio?: number
  tokenizer: TokenizerPort
}

/** Cap on how many characters we may grow a chunk by in one bisection step.
 *  Prevents pathological tokenizers (one that returns 1 token regardless of
 *  input length) from looping forever — we still cap chunk size by chars. */
const CHAR_GROW_CAP = 4096

/** Walk `text` until the prefix length first exceeds `target` tokens, using
 *  exponential growth + binary refinement. Returns the LARGEST prefix whose
 *  token count is `<= target`. */
const longestPrefixWithinBudget = (
  text: string,
  start: number,
  target: number,
  tok: TokenizerPort,
): number => {
  if (start >= text.length) return start
  if (target <= 0) return start
  // Exponential probe: find an upper bound `hi` whose count > target (or end).
  let lo = start
  let hi = Math.min(text.length, start + 1)
  let step = 1
  while (hi < text.length && tok.count(text.slice(start, hi)) <= target) {
    lo = hi
    step = Math.min(step * 2, CHAR_GROW_CAP)
    hi = Math.min(text.length, hi + step)
  }
  // If the entire remainder fits, return end.
  if (hi >= text.length && tok.count(text.slice(start, hi)) <= target) {
    return text.length
  }
  // Binary refine in [lo, hi].
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (tok.count(text.slice(start, mid)) <= target) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return lo
}

/** Walk back from `end` until the suffix length is `>= overlapTokens` tokens
 *  OR we hit `start`. Returns the smallest position whose suffix is at most
 *  that many tokens long (so the next chunk starts at that position). */
const overlapStartPos = (
  text: string,
  end: number,
  start: number,
  overlapTokens: number,
  tok: TokenizerPort,
): number => {
  if (overlapTokens <= 0) return end
  // Binary search the start position in [start, end] s.t. tokens(text[pos..end]) ≈ overlapTokens.
  let lo = start
  let hi = end
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    const t = tok.count(text.slice(mid, end))
    if (t >= overlapTokens) {
      lo = mid
    } else {
      hi = mid
    }
  }
  // Prefer `lo` (the LARGER suffix), so overlap is at least `overlapTokens`
  // when possible.
  return lo
}

/** Validate options + bucket budget. Throws on invalid config (including NaN,
 *  which compares false for every relational op and would silently pass a
 *  naive `ratio < 0 || ratio >= 1` check). */
const validateOptions = (opts: ChunkBucketOptions): { budget: number; ratio: number } => {
  const ratioRaw = opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO
  if (!Number.isFinite(ratioRaw) || ratioRaw < 0 || ratioRaw >= 1) {
    throw new RetrievalError(`overlapRatio out of range [0, 1): ${ratioRaw}`)
  }
  const budget = BUCKET_TOKENS[opts.bucket]
  if (budget <= 0) {
    throw new RetrievalError(`invalid bucket budget for ${opts.bucket}`)
  }
  return { budget, ratio: ratioRaw }
}

/** Cap on the number of chunks the loop may produce — guards against a
 *  degenerate tokenizer that always returns 0. Honest tokenizers + typical
 *  doc sizes (≤ ~10 MB) never approach this. */
const CHUNK_LOOP_GUARD = 1_000_000

/** Step one chunk forward from `pos`. Returns `{ next, end }` where `end`
 *  is the chunk's exclusive end and `next` is the start of the next chunk
 *  (always > pos to guarantee forward progress). */
const stepOnce = (
  text: string,
  pos: number,
  budget: number,
  overlapTokens: number,
  tok: TokenizerPort,
): { chunk: string; next: number; atEnd: boolean } => {
  const end = longestPrefixWithinBudget(text, pos, budget, tok)
  if (end <= pos) {
    // Tokenizer says even one char exceeds budget — emit a 1-char chunk
    // to make forward progress; the caller's tokenizer is broken but we
    // still return something well-defined.
    return { chunk: text.slice(pos, pos + 1), next: pos + 1, atEnd: pos + 1 >= text.length }
  }
  const chunk = text.slice(pos, end)
  if (end >= text.length) return { chunk, next: end, atEnd: true }
  const nextStart = overlapStartPos(text, end, pos, overlapTokens, tok)
  const next = nextStart > pos ? nextStart : pos + 1
  return { chunk, next, atEnd: false }
}

/**
 * Split `text` into chunks per `opts.bucket`. Returns `[text]` unchanged for
 * the `identity` bucket OR when `text` already fits within the budget.
 *
 * Invariants:
 *   - Each returned chunk has token count `<= BUCKET_TOKENS[bucket]`
 *   - Adjacent chunks overlap by `≈ overlapRatio * bucketTokens` tokens
 *   - Concatenating chunks with overlap removed reproduces `text`
 *   - Pure / deterministic for a fixed `tokenizer.count`
 */
export const rechunk = (text: string, opts: ChunkBucketOptions): readonly string[] => {
  if (opts.bucket === "identity") return [text]
  const { budget, ratio } = validateOptions(opts)
  if (text.length === 0) return []
  const total = opts.tokenizer.count(text)
  if (total <= budget) return [text]
  const overlapTokens = Math.max(0, Math.floor(budget * ratio))
  const chunks: string[] = []
  let pos = 0
  let guard = CHUNK_LOOP_GUARD
  while (pos < text.length) {
    if (guard-- <= 0) {
      throw new RetrievalError("chunk-bucket loop guard exceeded — tokenizer likely degenerate")
    }
    const step = stepOnce(text, pos, budget, overlapTokens, opts.tokenizer)
    chunks.push(step.chunk)
    if (step.atEnd) break
    pos = step.next
  }
  return chunks
}
