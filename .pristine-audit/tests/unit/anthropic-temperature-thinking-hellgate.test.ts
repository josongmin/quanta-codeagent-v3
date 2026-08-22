/**
 * Hellgate — Anthropic `temperature` × extended-thinking mutual exclusion.
 *
 * Anthropic Messages returns HTTP 400 ("temperature may only be set to 1 when
 * thinking is enabled") whenever `temperature` != 1 is sent together with active
 * thinking (`{type:"enabled"|"adaptive"}`). The repair-breadth fanout
 * (QUANTA_BENCH_SAMPLE_TEMP) injects temperature 0.8 into candidate lanes; if a
 * lane runs a thinking-enabled Claude model, EVERY candidate fork would 400 —
 * the exact breadth-collapse the sampling guard exists to prevent.
 *
 * Invariants:
 *   1. temperature + thinking ENABLED  ⇒ temperature OMITTED (defaults to 1).
 *   2. temperature + thinking ADAPTIVE ⇒ temperature OMITTED.
 *   3. temperature + thinking DISABLED ⇒ temperature PRESENT (caller's value).
 *   4. temperature + NO thinking       ⇒ temperature PRESENT (byte-identical).
 *   5. thinking active + NO temperature ⇒ no temperature key (byte-identical).
 */
import { describe, expect, test } from "bun:test"
import type { StreamInput, ThinkingConfig } from "@/llm"
import { buildAnthropicMessagesRequest } from "@/llm/anthropic-messages-codec"

const reqOf = (temperature?: number, thinking?: ThinkingConfig) =>
  buildAnthropicMessagesRequest("claude-opus-4-8", 1024, {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...(temperature !== undefined ? { temperature } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  } as unknown as StreamInput) as unknown as Record<string, unknown>

describe("anthropic temperature × thinking — active thinking suppresses temperature", () => {
  test("temperature 0.8 + thinking enabled ⇒ temperature OMITTED (would 400)", () => {
    const req = reqOf(0.8, { type: "enabled", budget_tokens: 1024 })
    expect("temperature" in req).toBe(false)
    expect("thinking" in req).toBe(true)
  })

  test("temperature 0.8 + thinking adaptive ⇒ temperature OMITTED", () => {
    const req = reqOf(0.8, { type: "adaptive" })
    expect("temperature" in req).toBe(false)
  })

  test("thinking active + no temperature ⇒ still no temperature key (byte-identical)", () => {
    expect("temperature" in reqOf(undefined, { type: "enabled", budget_tokens: 1024 })).toBe(false)
  })
})

describe("anthropic temperature × thinking — temperature preserved when thinking off", () => {
  test("temperature 0.8 + thinking disabled ⇒ temperature PRESENT", () => {
    expect(reqOf(0.8, { type: "disabled" }).temperature).toBe(0.8)
  })

  test("temperature 0.8 + NO thinking ⇒ temperature PRESENT (byte-identical)", () => {
    expect(reqOf(0.8).temperature).toBe(0.8)
  })

  test("no temperature + no thinking ⇒ no temperature key", () => {
    expect("temperature" in reqOf()).toBe(false)
  })
})
