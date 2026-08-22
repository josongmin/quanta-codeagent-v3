/**
 * HELLGATE — adversarial chunk-bucket re-chunker proofs (ADR-0159 Axis B).
 *
 * Invariants under attack: (i) NO chunk exceeds its bucket budget, even
 * with pathological tokenizers; (ii) loop ALWAYS makes forward progress
 * (no infinite loop); (iii) byte-deterministic across repeated calls;
 * (iv) overlap actually shrinks duplicated content between adjacent
 * chunks; (v) invalid options THROW (no silent default substitution).
 *
 * 13 adversarial cases.
 */

import { describe, expect, test } from "bun:test"
import {
  BUCKET_TOKENS,
  DEFAULT_OVERLAP_RATIO,
  RetrievalError,
  rechunk,
  type TokenizerPort,
} from "@/retrieval"

const charTok: TokenizerPort = { count: (s) => s.length }

describe("chunk-bucket hellgate", () => {
  test("pathological tokenizer that always returns 0 → loop guard kicks", () => {
    const zeroTok: TokenizerPort = { count: () => 0 }
    // With count=0 always, the recursion would normally not terminate;
    // the implementation says total<=budget early-exits — verify that.
    const out = rechunk("x".repeat(100), { bucket: "small-600", tokenizer: zeroTok })
    expect(out).toEqual(["x".repeat(100)]) // total=0, fits in any budget
  })

  test("tokenizer that always returns Infinity → 1-char-chunks fallback", () => {
    const infTok: TokenizerPort = { count: (s) => (s.length === 0 ? 0 : Infinity) }
    const out = rechunk("abc", { bucket: "small-600", tokenizer: infTok })
    // Every char "exceeds" budget; we still get a result (one char per chunk).
    expect(out.length).toBe(3)
    expect(out).toEqual(["a", "b", "c"])
  })

  test("identity bucket bypasses validation — accepts even nonsensical overlap", () => {
    const out = rechunk("hello", {
      bucket: "identity",
      overlapRatio: 0.999,
      tokenizer: charTok,
    })
    expect(out).toEqual(["hello"])
  })

  test("overlapRatio === 1 throws (open interval [0,1))", () => {
    expect(() =>
      rechunk("x".repeat(1000), { bucket: "small-600", overlapRatio: 1, tokenizer: charTok }),
    ).toThrow(RetrievalError)
  })

  test("overlapRatio NaN throws", () => {
    expect(() =>
      rechunk("x".repeat(1000), {
        bucket: "small-600",
        overlapRatio: Number.NaN,
        tokenizer: charTok,
      }),
    ).toThrow(RetrievalError)
  })

  test("empty text never produces empty chunks within a non-empty output", () => {
    const out = rechunk("", { bucket: "small-600", tokenizer: charTok })
    expect(out).toEqual([])
  })

  test("byte-deterministic across 5 invocations on the same input", () => {
    const text = "Hello, world! ".repeat(200)
    const runs = Array.from({ length: 5 }, () =>
      rechunk(text, { bucket: "small-600", tokenizer: charTok }),
    )
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toEqual(runs[0] ?? [])
    }
  })

  test("very long text never returns more chunks than ceil(N / (budget * (1-ratio)))", () => {
    const N = 100_000
    const text = "x".repeat(N)
    const out = rechunk(text, { bucket: "small-600", tokenizer: charTok })
    // With overlap=0.1, stride ≈ 540, so max chunks ≤ N/540 + 1
    const maxExpected = Math.ceil(N / 540) + 2
    expect(out.length).toBeLessThanOrEqual(maxExpected)
  })

  test("every chunk is ≤ budget tokens, no exceptions", () => {
    const text = "x".repeat(10_000)
    for (const bucket of ["small-600", "medium-2400", "large-4000"] as const) {
      const out = rechunk(text, { bucket, tokenizer: charTok })
      for (const ch of out) {
        expect(charTok.count(ch)).toBeLessThanOrEqual(BUCKET_TOKENS[bucket])
      }
    }
  })

  test("adjacent chunks overlap (with default ratio) — last chars of chunk i appear at start of chunk i+1", () => {
    const text = "abcdefghij".repeat(200) // 2000 chars
    const out = rechunk(text, { bucket: "small-600", tokenizer: charTok })
    expect(out.length).toBeGreaterThan(1)
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1] ?? ""
      const curr = out[i] ?? ""
      // The current chunk's first ~60 chars should match a suffix of prev.
      const overlap = prev.slice(-60)
      expect(curr.startsWith(overlap)).toBe(true)
    }
  })

  test("single-char text returns single chunk for any bucket", () => {
    for (const bucket of ["small-600", "medium-2400", "large-4000"] as const) {
      expect(rechunk("x", { bucket, tokenizer: charTok })).toEqual(["x"])
    }
  })

  test("chunks reconstruct the original text when overlap is removed", () => {
    const text = "abc".repeat(500) // 1500 chars
    const out = rechunk(text, {
      bucket: "small-600",
      overlapRatio: 0,
      tokenizer: charTok,
    })
    expect(out.join("")).toBe(text)
  })

  test("tokenizer counts in unicode code points: 4-byte chars do not break chunking", () => {
    // Count by JS string length (UTF-16 code units). Mixed BMP/non-BMP still chunks.
    const text = "🚀hello🚀world".repeat(150) // each 🚀 is 2 UTF-16 units
    const out = rechunk(text, { bucket: "small-600", tokenizer: charTok })
    for (const ch of out) {
      expect(charTok.count(ch)).toBeLessThanOrEqual(600)
    }
    // No chunk should be empty.
    for (const ch of out) expect(ch.length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ */
/* merged from retrieval-chunk-bucket.test.ts */
/* ------------------------------------------------------------------ */

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

  test("repeated-content cache suppresses duplicate tokenizer calls on adversarial repeated input", () => {
    const counts = new Map<string, number>()
    const tok: TokenizerPort = {
      count(text) {
        counts.set(text, (counts.get(text) ?? 0) + 1)
        return text.length
      },
    }
    rechunk("a".repeat(4000), { bucket: "small-600", tokenizer: tok })
    const duplicates = [...counts.values()].filter((n) => n > 1)
    expect(duplicates).toEqual([])
    expect(counts.size).toBeGreaterThan(1)
  })
})
