/**
 * Hellgate e2e — 1M-context factory wiring (gap-other-agent GAP 3).
 *
 * Drives the REAL composition path: `createLLM("anthropic", …)` → the anthropic
 * adapter builder → `resolveContext1M` → the adapter's `betaHeaders`. Proves the
 * `[1m]` suffix / `QUANTA_CONTEXT_1M` knob actually reaches the wire as the
 * `context-1m-2025-08-07` beta header, and that the OFF path is byte-identical.
 */
import { describe, expect, test } from "bun:test"
import { createLLM } from "@/llm"
import type { AnthropicAdapter } from "@/llm/adapters/anthropic"
import { CONTEXT_1M_BETA } from "@/llm/context-1m"

const KEY = { ANTHROPIC_API_KEY: "sk-ant-test" }
const betas = (model: string, env: Record<string, string | undefined> = {}): readonly string[] =>
  (createLLM("anthropic", { model }, { ...KEY, ...env }) as unknown as AnthropicAdapter).betaHeaders

describe("1M-context factory e2e — activation", () => {
  test("[1m] suffix on eligible model ⇒ 1M beta header on the adapter", () => {
    expect(betas("claude-sonnet-4-5[1m]")).toContain(CONTEXT_1M_BETA)
  })
  test("QUANTA_CONTEXT_1M knob activates eligible model", () => {
    expect(betas("claude-sonnet-4-5", { QUANTA_CONTEXT_1M: "1" })).toContain(CONTEXT_1M_BETA)
  })
})

describe("1M-context factory e2e — byte-identical OFF", () => {
  test("plain eligible model, no knob ⇒ NO 1M beta", () => {
    expect(betas("claude-sonnet-4-5")).not.toContain(CONTEXT_1M_BETA)
  })
  test("ineligible model with suffix ⇒ NO 1M beta (suffix stripped, inactive)", () => {
    expect(betas("claude-opus-4-8[1m]")).not.toContain(CONTEXT_1M_BETA)
  })
  test("no duplicate 1M beta when knob + suffix both set", () => {
    const n = betas("claude-sonnet-4-5[1m]", { QUANTA_CONTEXT_1M: "1" }).filter(
      (h) => h === CONTEXT_1M_BETA,
    ).length
    expect(n).toBe(1)
  })
})
