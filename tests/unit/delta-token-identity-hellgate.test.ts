/**
 * Hellgate — delta token counter BYTE-IDENTITY (RFC jun-6-delta-token-accounting §6.1).
 *
 * The load-bearing invariant: at EVERY step of any append/remove/reseed sequence,
 * `counter.total()` EXACTLY equals a full `estimateTokens(currentMessages)` re-scan.
 * The counter is an optimization, not a behavior change — it must be PROVABLY equal
 * to the full scan. This battery proves that across:
 *   - 100+ fuzzed random-growth sequences (the byte-identity invariant)
 *   - the ceil-of-sum ≠ sum-of-ceils edge (per-message chars NOT multiples of 4)
 *   - image / document / thinking / tool blocks (shared `charsOf` per-block estimates)
 *   - empty + single-message edges
 *   - remove-below-zero clamp + reseed self-heal
 *
 * Deterministic PRNG (no Math.random — the no-sketchy-code scanner bans it).
 */

import { describe, expect, test } from "bun:test"
import { charsOf, createTokenDeltaCounter, estimateTokens } from "@/agent"
import type { Message } from "@/llm"

// --- deterministic LCG (Numerical Recipes) — seeded, reproducible, no Math.random ---
const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// Build a message whose blocks deliberately produce char counts that are NOT
// multiples of 4 — this is what would expose a sum-of-ceils drift if the counter
// ceil'd per-message instead of tracking the pre-ceil char sum.
const mkMessage = (rng: () => number, i: number): Message => {
  const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant"
  const pick = Math.floor(rng() * 6)
  const len = 1 + Math.floor(rng() * 37) // odd-ish lengths ⇒ chars not %4
  switch (pick) {
    case 0:
      return { role, content: [{ type: "text", text: "x".repeat(len) }] }
    case 1:
      return { role, content: [{ type: "thinking", thinking: "t".repeat(len) }] }
    case 2:
      return {
        role,
        content: [{ type: "tool_use", id: `u${i}`, name: "n".repeat(len), input: { a: len } }],
      }
    case 3:
      return {
        role,
        content: [{ type: "tool_result", tool_use_id: `u${i}`, content: "r".repeat(len) }],
      }
    case 4:
      // image — fixed IMAGE_CHAR_ESTIMATE inside charsOf
      return { role, content: [{ type: "image", data: "z".repeat(len), mediaType: "image/png" }] }
    default:
      // document — fixed DOCUMENT_CHAR_ESTIMATE inside charsOf
      return {
        role,
        content: [{ type: "document", data: "p".repeat(len), mediaType: "application/pdf" }],
      }
  }
}

// One fuzzed mutation step: pick append / remove-prefix / reseed, apply to both
// `current` (the ground truth array) and `counter`. Returns the (possibly bumped)
// next message id. Extracted from the test body to keep cognitive complexity low.
const applyStep = (
  rng: () => number,
  current: Message[],
  counter: ReturnType<typeof createTokenDeltaCounter>,
  nextId: number,
): number => {
  const action = rng()
  if (action < 0.55 || current.length === 0) {
    const n = 1 + Math.floor(rng() * 4)
    const added: Message[] = []
    for (let k = 0; k < n; k++) added.push(mkMessage(rng, nextId++))
    current.push(...added)
    counter.onAppend(added)
    return nextId
  }
  if (action < 0.85) {
    const n = 1 + Math.floor(rng() * current.length)
    counter.onRemove(current.splice(0, n))
    return nextId
  }
  counter.reseed(current)
  return nextId
}

describe("delta-token identity — counter.total() === full estimateTokens", () => {
  test("fuzz: 100 random append/remove/reseed sequences stay byte-identical at every step", () => {
    const SEQUENCES = 100
    for (let seq = 0; seq < SEQUENCES; seq++) {
      const rng = lcg(0xc0ffee + seq * 97)
      const current: Message[] = []
      const counter = createTokenDeltaCounter(current) // seeded from []
      expect(counter.total()).toBe(estimateTokens(current)) // sanity at seed

      const STEPS = 5 + Math.floor(rng() * 25)
      let nextId = 0
      for (let step = 0; step < STEPS; step++) {
        nextId = applyStep(rng, current, counter, nextId)
        // THE invariant — exact, no tolerance
        expect(counter.total()).toBe(estimateTokens(current))
      }
    }
  })

  test("ceil-of-sum ≠ sum-of-ceils: a naive per-message ceil WOULD drift; the counter does NOT", () => {
    // Two messages of 1 char each. charsOf = 2 ⇒ ceil(2/4) = 1 (full scan).
    // Naive sum-of-ceils: ceil(1/4)+ceil(1/4) = 1+1 = 2. The counter must give 1.
    const a: Message = { role: "user", content: [{ type: "text", text: "a" }] }
    const b: Message = { role: "assistant", content: [{ type: "text", text: "b" }] }

    const counter = createTokenDeltaCounter([])
    counter.onAppend([a])
    counter.onAppend([b])

    const full = estimateTokens([a, b])
    const naiveSumOfCeils = estimateTokens([a]) + estimateTokens([b])

    expect(full).toBe(1) // ceil(2/4)
    expect(naiveSumOfCeils).toBe(2) // the WRONG approach
    expect(counter.total()).toBe(full) // the counter matches the full scan, not the naive sum
    expect(counter.total()).not.toBe(naiveSumOfCeils)
  })

  test("ceil edge across many small appends: charsOf is additive, ceil applied once", () => {
    // 7 single-char appends ⇒ charsOf = 7 ⇒ ceil(7/4) = 2. Sum-of-ceils would be 7.
    const counter = createTokenDeltaCounter([])
    const msgs: Message[] = []
    for (let i = 0; i < 7; i++) {
      const m: Message = { role: "user", content: [{ type: "text", text: "q" }] }
      msgs.push(m)
      counter.onAppend([m])
    }
    expect(charsOf(msgs)).toBe(7)
    expect(counter.total()).toBe(2) // ceil(7/4), NOT 7
    expect(counter.total()).toBe(estimateTokens(msgs))
  })

  test("image + document + mixed blocks: delta tracks the shared per-block estimates", () => {
    const counter = createTokenDeltaCounter([])
    const seq: Message[] = []
    const add = (m: Message) => {
      seq.push(m)
      counter.onAppend([m])
      expect(counter.total()).toBe(estimateTokens(seq))
    }
    add({ role: "user", content: [{ type: "image", data: "zzz", mediaType: "image/png" }] })
    add({
      role: "user",
      content: [{ type: "document", data: "ppp", mediaType: "application/pdf" }],
    })
    add({
      role: "assistant",
      content: [
        { type: "text", text: "hello world" },
        { type: "thinking", thinking: "pondering" },
      ],
    })
    add({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } }],
    })
    add({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "match" }] })
  })
})

describe("delta-token corrupt-state guards", () => {
  test("remove more than present clamps total at 0, reseed restores truth", () => {
    const a: Message = { role: "user", content: [{ type: "text", text: "small" }] }
    const counter = createTokenDeltaCounter([a])
    expect(counter.total()).toBe(estimateTokens([a]))

    // Remove a fabricated, larger set than is actually present — must clamp, not go negative.
    const big: Message = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(1000) }],
    }
    counter.onRemove([a, big])
    expect(counter.total()).toBe(0)
    expect(counter.total()).toBeGreaterThanOrEqual(0)

    // Reseed self-heals to ground truth.
    const truth: Message[] = [a, big]
    counter.reseed(truth)
    expect(counter.total()).toBe(estimateTokens(truth))
  })

  test("reseed === full recompute", () => {
    const counter = createTokenDeltaCounter([])
    const m: Message[] = [
      { role: "user", content: [{ type: "text", text: "abcdefg" }] },
      { role: "assistant", content: [{ type: "text", text: "hijkl" }] },
    ]
    counter.reseed(m)
    expect(counter.total()).toBe(estimateTokens(m))
  })
})

describe("delta-token empty / single edges", () => {
  test("empty seed ⇒ total 0 ⇒ matches estimateTokens([])", () => {
    const counter = createTokenDeltaCounter([])
    expect(counter.total()).toBe(0)
    expect(counter.total()).toBe(estimateTokens([]))
  })

  test("single message ⇒ matches full scan", () => {
    const m: Message = { role: "user", content: [{ type: "text", text: "only" }] }
    const counter = createTokenDeltaCounter([m])
    expect(counter.total()).toBe(estimateTokens([m]))
  })

  test("append empty array is a no-op (estimateTokens([]) === 0)", () => {
    const m: Message = { role: "user", content: [{ type: "text", text: "stable" }] }
    const counter = createTokenDeltaCounter([m])
    const before = counter.total()
    counter.onAppend([])
    expect(counter.total()).toBe(before)
    expect(counter.total()).toBe(estimateTokens([m]))
  })
})
