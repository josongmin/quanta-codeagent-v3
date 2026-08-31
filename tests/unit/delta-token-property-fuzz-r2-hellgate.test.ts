/**
 * Hellgate ROUND 2 (PROPERTY / DIFFERENTIAL FUZZ) — delta token counter
 * BYTE-IDENTITY (RFC jun-6-delta-token-accounting §4.1, §6.1).
 *
 * Round 1 (`delta-token-identity-hellgate`) fuzzed APPEND-mostly growth with
 * prefix-only removals. This round 2 attacks the SAME load-bearing invariant
 *
 *     counter.total() === estimateTokens(currentMessages)   AT EVERY STEP
 *
 * with a DIFFERENT methodology:
 *   - ≥500 random mutation sequences (vs 100), longer sequences,
 *   - removals from ARBITRARY positions (not just the prefix splice) — the
 *     counter subtracts `charsOf(removed)` which is order-independent, so a
 *     scattered multi-message removal is a strictly stronger property than a
 *     contiguous prefix drop,
 *   - the FULL block zoo every step: text / thinking / tool_use (incl.
 *     `input: undefined` ⇒ `JSON.stringify({})`), tool_result (incl. optional
 *     `contentBlocks` which `blockChars` does NOT count — only `content`),
 *     image, document, AND a forward-compat UNKNOWN block (exercises the
 *     `_exhaustive` runtime fallback `JSON.stringify`),
 *   - empty-list appends/removes interleaved,
 *   - reseed self-heal probed mid-sequence.
 *
 * ZERO tolerance: a single 1-token divergence at any step fails. A pass at
 * N≥500 is a proof of the memoization equivalence, not a smoke test.
 *
 * Deterministic LCG (no Math.random / Date.now — scanner-banned).
 */

import { describe, expect, test } from "bun:test"
import { charsOf, createTokenDeltaCounter, estimateTokens } from "@/agent"
import type { ContentBlock, Message } from "@/llm"

// --- seeded LCG (Numerical Recipes), reproducible, no Math.random ---
const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const pick = (rng: () => number, n: number): number => Math.floor(rng() * n) % n
// Lengths deliberately NOT multiples of 4 ⇒ exposes any sum-of-ceils drift.
const oddLen = (rng: () => number): number => 1 + pick(rng, 41)

// Build a content block of a random variant, including a forward-compat UNKNOWN
// variant (cast through unknown) to exercise the runtime `_exhaustive` fallback.
const mkBlock = (rng: () => number): ContentBlock => {
  switch (pick(rng, 8)) {
    case 0:
      return { type: "text", text: "λ".repeat(oddLen(rng)) }
    case 1:
      return { type: "thinking", thinking: "t".repeat(oddLen(rng)) }
    case 2:
      // input: undefined ⇒ JSON.stringify(input ?? {}) === "{}" (length 2)
      return { type: "tool_use", id: "u", name: "n".repeat(oddLen(rng)), input: undefined }
    case 3:
      return {
        type: "tool_use",
        id: "u",
        name: "fn",
        input: { a: pick(rng, 999), b: "z".repeat(oddLen(rng)) },
      }
    case 4:
      // contentBlocks is NOT counted by blockChars — only `content`. Including
      // it asserts the counter and the full scan agree to IGNORE it identically.
      return {
        type: "tool_result",
        tool_use_id: "u",
        content: "r".repeat(oddLen(rng)),
        contentBlocks: [{ type: "text", text: "IGNORED".repeat(oddLen(rng)) }],
      }
    case 5:
      return { type: "image", data: "AAAA".repeat(oddLen(rng)), mediaType: "image/png" }
    case 6:
      return { type: "document", data: "BBBB".repeat(oddLen(rng)), mediaType: "application/pdf" }
    default:
      // Forward-compat UNKNOWN variant — exercises blockChars' runtime fallback
      // (`JSON.stringify(_exhaustive)`). Cast through unknown to bypass the
      // closed union at the test boundary (a real payload could carry one).
      return { type: "video", url: "x".repeat(oddLen(rng)) } as unknown as ContentBlock
  }
}

const mkMessage = (rng: () => number): Message => {
  const role: "user" | "assistant" = pick(rng, 2) === 0 ? "user" : "assistant"
  const blocks = 1 + pick(rng, 4)
  const content: ContentBlock[] = []
  for (let i = 0; i < blocks; i++) content.push(mkBlock(rng))
  return { role, content }
}

const appendRandomMessages = (
  rng: () => number,
  current: Message[],
  counter: ReturnType<typeof createTokenDeltaCounter>,
): void => {
  const added: Message[] = []
  const count = pick(rng, 4)
  for (let index = 0; index < count; index++) added.push(mkMessage(rng))
  current.push(...added)
  counter.onAppend(added)
}

const removeScatteredMessages = (
  rng: () => number,
  current: Message[],
  counter: ReturnType<typeof createTokenDeltaCounter>,
): void => {
  const removed: Message[] = []
  const count = 1 + pick(rng, current.length)
  for (let index = 0; index < count; index++) {
    const position = pick(rng, current.length)
    removed.push(current[position] as Message)
    current.splice(position, 1)
  }
  counter.onRemove(removed)
}

const applyMutation = (
  rng: () => number,
  current: Message[],
  counter: ReturnType<typeof createTokenDeltaCounter>,
): void => {
  const operation = pick(rng, 10)
  if (operation <= 4) {
    appendRandomMessages(rng, current, counter)
  } else if (operation <= 7 && current.length > 0) {
    removeScatteredMessages(rng, current, counter)
  } else if (operation === 8) {
    counter.reseed(current)
  } else {
    counter.onRemove([])
  }
}

const assertCounterMatchesScan = (
  seed: number,
  step: number,
  current: readonly Message[],
  counter: ReturnType<typeof createTokenDeltaCounter>,
): void => {
  const scan = estimateTokens([...current])
  if (counter.total() !== scan) {
    throw new Error(
      `INVARIANT VIOLATION seed=${seed} step=${step}: counter=${counter.total()} scan=${scan} len=${current.length}`,
    )
  }
  expect(counter.total()).toBe(scan)
}

const runDeltaSequence = (seed: number): void => {
  const rng = lcg(seed * 2654435761)
  const current: Message[] = []
  const counter = createTokenDeltaCounter(current)
  const steps = 6 + pick(rng, 24)
  for (let step = 0; step < steps; step++) {
    applyMutation(rng, current, counter)
    assertCounterMatchesScan(seed, step, current, counter)
  }
}

describe("delta-token property fuzz R2 — byte-identity under arbitrary mutation", () => {
  test("≥500 random append/scattered-remove/reseed sequences: total()===scan at EVERY step", () => {
    const SEQUENCES = 600
    for (let seed = 1; seed <= SEQUENCES; seed++) runDeltaSequence(seed)
  })

  test("charsOf is an exact homomorphism over concatenation: A++B (500 random splits)", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = lcg(seed * 40503 + 7)
      const a: Message[] = []
      const b: Message[] = []
      for (let i = 0; i < 1 + pick(rng, 6); i++) a.push(mkMessage(rng))
      for (let i = 0; i < pick(rng, 6); i++) b.push(mkMessage(rng))
      // charsOf(A)+charsOf(B) === charsOf(A++B) EXACTLY — the algebraic core
      // that makes the incremental total provably equal the full scan.
      expect(charsOf(a) + charsOf(b)).toBe(charsOf([...a, ...b]))
    }
  })

  test("reseed mid-sequence self-heals after a bogus over-remove (drift below truth)", () => {
    const rng = lcg(0xdecaf)
    const truth: Message[] = []
    const counter = createTokenDeltaCounter(truth)
    for (let i = 0; i < 5; i++) {
      const m = mkMessage(rng)
      truth.push(m)
      counter.onAppend([m])
    }
    // Subtract messages that were NEVER added ⇒ tracked total drifts below truth
    // (clamped at 0, never negative/NaN).
    counter.onRemove([mkMessage(rng), mkMessage(rng), mkMessage(rng)])
    expect(counter.total()).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(counter.total())).toBe(false)
    // reseed is the documented self-heal.
    counter.reseed(truth)
    expect(counter.total()).toBe(estimateTokens(truth))
  })
})
