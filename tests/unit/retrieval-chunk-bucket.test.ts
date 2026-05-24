/**
 * Unit — chunk-bucket re-chunker (ADR-0159 Axis B).
 *
 * The TokenizerPort is injected. Tests use deterministic tokenizers so
 * the chunk boundaries are predictable.
 */
import { describe, expect, test } from "bun:test"
import {
  BUCKET_TOKENS,
  DEFAULT_OVERLAP_RATIO,
  RetrievalError,
  rechunk,
  type TokenizerPort,
} from "@/retrieval"

/** Token = one ASCII char. Easy to reason about chunk boundaries. */
const charTokenizer: TokenizerPort = { count: (s) => s.length }

describe("rechunk", () => {
  test("identity bucket returns text unchanged", () => {
    const out = rechunk("hello world", { bucket: "identity", tokenizer: charTokenizer })
    expect(out).toEqual(["hello world"])
  })

  test("empty text returns []", () => {
    const out = rechunk("", { bucket: "small-600", tokenizer: charTokenizer })
    expect(out).toEqual([])
  })

  test("text within budget returns single chunk", () => {
    const text = "a".repeat(100)
    const out = rechunk(text, { bucket: "small-600", tokenizer: charTokenizer })
    expect(out).toEqual([text])
  })

  test("text > budget splits into overlapping chunks", () => {
    const text = "a".repeat(1500)
    const out = rechunk(text, { bucket: "small-600", tokenizer: charTokenizer })
    expect(out.length).toBeGreaterThan(1)
    for (const ch of out) {
      expect(charTokenizer.count(ch)).toBeLessThanOrEqual(BUCKET_TOKENS["small-600"])
    }
  })

  test("default overlap is 10%", () => {
    expect(DEFAULT_OVERLAP_RATIO).toBe(0.1)
  })

  test("overlapRatio=0 produces non-overlapping chunks", () => {
    const text = "a".repeat(1500)
    const out = rechunk(text, {
      bucket: "small-600",
      overlapRatio: 0,
      tokenizer: charTokenizer,
    })
    // With no overlap, length 1500 / 600 = 3 chunks (600+600+300).
    expect(out.length).toBe(3)
  })

  test("overlapRatio out of range throws", () => {
    expect(() =>
      rechunk("x".repeat(1000), {
        bucket: "small-600",
        overlapRatio: -0.1,
        tokenizer: charTokenizer,
      }),
    ).toThrow(RetrievalError)
    expect(() =>
      rechunk("x".repeat(1000), { bucket: "small-600", overlapRatio: 1, tokenizer: charTokenizer }),
    ).toThrow(RetrievalError)
  })

  test("deterministic for fixed tokenizer", () => {
    const text = "hello world, this is a longer document used for testing chunk bucket. ".repeat(50)
    const a = rechunk(text, { bucket: "small-600", tokenizer: charTokenizer })
    const b = rechunk(text, { bucket: "small-600", tokenizer: charTokenizer })
    expect(a).toEqual(b)
  })

  test("medium and large buckets honor budget", () => {
    const text = "x".repeat(5000)
    const med = rechunk(text, { bucket: "medium-2400", tokenizer: charTokenizer })
    const lg = rechunk(text, { bucket: "large-4000", tokenizer: charTokenizer })
    for (const ch of med) expect(ch.length).toBeLessThanOrEqual(2400)
    for (const ch of lg) expect(ch.length).toBeLessThanOrEqual(4000)
  })
})
