/**
 * Pin the OpenAI token-cap parameter family detector.
 *
 * Bug it closes: OpenAI's reasoning + GPT-5 generations REJECT `max_tokens`
 * with HTTP 400 ("not supported with this model. Use `max_completion_tokens`
 * instead"). The adapter previously sent `max_tokens` unconditionally, so
 * any run on `gpt-5-mini` / `o1` / `o3` died at turn 0 with no patch.
 *
 * Detection is by MODEL PREFIX (structural — not a regex on the 400 error
 * message we get back). Adding a new family ⇒ one line in
 * `usesCompletionTokensParam`, and this test pins the contract so a typo
 * (e.g. `gpt-5` vs `gpt5`) gets caught at unit time.
 */
import { describe, expect, test } from "bun:test"
import { usesCompletionTokensParam } from "@/llm/adapters/openai"

describe("OpenAI token-cap param family", () => {
  test("reasoning + GPT-5 families use max_completion_tokens", () => {
    for (const m of [
      "o1",
      "o1-mini",
      "o1-preview",
      "o3",
      "o3-mini",
      "o4",
      "o4-mini",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-turbo",
    ]) {
      expect(usesCompletionTokensParam(m)).toBe(true)
    }
  })

  test("legacy chat models use max_tokens", () => {
    for (const m of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "chatgpt-4o-latest",
    ]) {
      expect(usesCompletionTokensParam(m)).toBe(false)
    }
  })

  test("case-insensitive on the prefix", () => {
    expect(usesCompletionTokensParam("GPT-5-MINI")).toBe(true)
    expect(usesCompletionTokensParam("O3-MINI")).toBe(true)
    expect(usesCompletionTokensParam("GPT-4o")).toBe(false)
  })
})
