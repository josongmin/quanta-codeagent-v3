/**
 * Hellgate — delta token accounting DEFAULT-OFF byte-identity + extraction equivalence
 * (RFC jun-6-delta-token-accounting §5.1, §6.1, §9).
 *
 * Two guarantees:
 *  1. The `charsOf` extraction left `estimateTokens` byte-identical: for many
 *     random transcripts, `estimateTokens(m) === Math.ceil(charsOf(m)/4)` and
 *     equals an independent re-implementation of the old inline loop. (If the
 *     extraction silently changed the arithmetic, every compaction threshold
 *     would shift — so this is the regression fence for the refactor.)
 *  2. The knob defaults OFF: `runtimeConfig().deltaTokenCount === false` with no
 *     env set, and ON only with strict `=== "1"`. Default-OFF means the loop
 *     never constructs the counter and calls `estimateTokens` directly — the
 *     "off path" IS the existing full re-scan, byte-identical by construction.
 */

import { describe, expect, test } from "bun:test"
import { charsOf, estimateTokens } from "@/agent"
import type { ContentBlock, Message } from "@/llm"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"

/** Drive `runtimeConfig` from an explicit env snapshot. `runtimeConfig` reads
 *  `process.env` through a cache, so we set/clear the key, reset the cache, read,
 *  then restore — mirroring the jun-04 default-off hellgate harness. */
const withEnv = <T>(value: string | undefined, fn: () => T): T => {
  const KEY = "QUANTA_DELTA_TOKEN_COUNT"
  const saved = process.env[KEY]
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  __resetRuntimeConfig()
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
    __resetRuntimeConfig()
  }
}

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// Independent re-implementation of the per-block char model + the OLD inline
// `estimateTokens` loop (sum then single ceil). If the refactor drifted, this
// reference disagrees with the production `estimateTokens`.
const IMAGE_CHAR_ESTIMATE = 6000
const DOCUMENT_CHAR_ESTIMATE = 12000
const refBlockChars = (b: ContentBlock): number => {
  switch (b.type) {
    case "text":
      return b.text.length
    case "thinking":
      return b.thinking.length
    case "tool_use":
      return b.name.length + JSON.stringify(b.input ?? {}).length
    case "tool_result":
      return b.content.length
    case "image":
      return IMAGE_CHAR_ESTIMATE
    case "document":
      return DOCUMENT_CHAR_ESTIMATE
    default:
      return JSON.stringify(b ?? {}).length
  }
}
const refEstimate = (messages: Message[]): number => {
  let chars = 0
  for (const m of messages) for (const b of m.content) chars += refBlockChars(b)
  return Math.ceil(chars / 4)
}

const mkMessage = (rng: () => number, i: number): Message => {
  const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant"
  const len = 1 + Math.floor(rng() * 53)
  const pick = Math.floor(rng() * 6)
  const blocks: ContentBlock[] = []
  switch (pick) {
    case 0:
      blocks.push({ type: "text", text: "x".repeat(len) })
      break
    case 1:
      blocks.push({ type: "thinking", thinking: "t".repeat(len) })
      break
    case 2:
      blocks.push({ type: "tool_use", id: `u${i}`, name: "n".repeat(len), input: { v: len } })
      break
    case 3:
      blocks.push({ type: "tool_result", tool_use_id: `u${i}`, content: "r".repeat(len) })
      break
    case 4:
      blocks.push({ type: "image", data: "z".repeat(len), mediaType: "image/png" })
      break
    default:
      blocks.push({ type: "document", data: "p".repeat(len), mediaType: "application/pdf" })
      break
  }
  return { role, content: blocks }
}

describe("charsOf extraction left estimateTokens byte-identical", () => {
  test("estimateTokens === ceil(charsOf/4) === independent old-loop reference (200 transcripts)", () => {
    for (let seq = 0; seq < 200; seq++) {
      const rng = lcg(0xfeed + seq * 131)
      const n = Math.floor(rng() * 30)
      const msgs: Message[] = []
      for (let i = 0; i < n; i++) msgs.push(mkMessage(rng, i))

      const prod = estimateTokens(msgs)
      expect(prod).toBe(Math.ceil(charsOf(msgs) / 4))
      expect(prod).toBe(refEstimate(msgs))
    }
  })

  test("empty ⇒ 0 chars ⇒ 0 tokens (matches reference)", () => {
    expect(charsOf([])).toBe(0)
    expect(estimateTokens([])).toBe(0)
    expect(estimateTokens([])).toBe(refEstimate([]))
  })
})

describe("knob default-OFF + strict opt-in", () => {
  test("deltaTokenCount is false when QUANTA_DELTA_TOKEN_COUNT is unset", () => {
    expect(withEnv(undefined, () => runtimeConfig().deltaTokenCount)).toBe(false)
  })

  test("strict `=== \"1\"`: only the literal '1' turns it on", () => {
    expect(withEnv("1", () => runtimeConfig().deltaTokenCount)).toBe(true)
    expect(withEnv("0", () => runtimeConfig().deltaTokenCount)).toBe(false)
    expect(withEnv("true", () => runtimeConfig().deltaTokenCount)).toBe(false)
    expect(withEnv("", () => runtimeConfig().deltaTokenCount)).toBe(false)
    expect(withEnv(" 1 ", () => runtimeConfig().deltaTokenCount)).toBe(false)
  })
})
