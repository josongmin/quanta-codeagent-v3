import { describe, expect, test } from "bun:test"
import { createLLM } from "@/llm"
import type { AnthropicAdapter } from "@/llm/adapters/anthropic"
import { CONTEXT_1M_BETA } from "@/llm/context-1m"

/**
 * REAL-FACTORY e2e for `context-1m-window` (QUANTA_CONTEXT_1M / `[1m]` suffix,
 * gap-other-agent GAP 3 / ADR-0505).
 *
 * Prior coverage (`tests/unit/context-1m-factory-e2e-hellgate.test.ts`) drives
 * `createLLM` and asserts the adapter's `betaHeaders` MIRROR field. This battery
 * goes one layer DEEPER — down onto the REAL `@anthropic-ai/sdk` client the
 * adapter constructs: the `context-1m-2025-08-07` beta must land on the SDK
 * client's `defaultHeaders` (the object the SDK merges into EVERY outbound HTTP
 * request), and the `[1m]` suffix must be STRIPPED off the model-id the client
 * actually sends while the 1M window key is pinned. OFF ⇒ no `anthropic-beta`
 * default header at all (byte-identical to a plain client).
 *
 * This is the real consumer (the wire-driving SDK client), not a helper mirror.
 */

const KEY = { ANTHROPIC_API_KEY: "sk-ant-test" }

/** The SDK client's constructor `defaultHeaders` — the object `@anthropic-ai/sdk`
 *  merges into every request it POSTs. Reading it proves the beta reaches the
 *  wire-driver, not just an adapter-local mirror. */
const clientDefaultHeaders = (
  model: string,
  env: Record<string, string | undefined> = {},
): Record<string, string> | undefined => {
  const adapter = createLLM(
    "anthropic",
    { model },
    { ...KEY, ...env },
  ) as unknown as AnthropicAdapter
  // The adapter holds the real SDK client; the SDK stashes constructor options
  // (incl. defaultHeaders) on `_options`. Structural access — no src edit.
  const client = (adapter as unknown as { client: { _options?: { defaultHeaders?: unknown } } })
    .client
  return client._options?.defaultHeaders as Record<string, string> | undefined
}

describe("context-1m — real SDK client wiring (ON)", () => {
  test("QUANTA_CONTEXT_1M ⇒ anthropic-beta default header on the real SDK client", () => {
    const headers = clientDefaultHeaders("claude-sonnet-4-5", { QUANTA_CONTEXT_1M: "1" })
    expect(headers?.["anthropic-beta"]).toBe(CONTEXT_1M_BETA)
  })

  test("[1m] suffix ⇒ header attaches AND the client model-id is the STRIPPED slug", () => {
    const adapter = createLLM(
      "anthropic",
      { model: "claude-sonnet-4-5[1m]" },
      KEY,
    ) as unknown as AnthropicAdapter
    // Model id the wire actually carries is canonical (suffix removed).
    expect(adapter.model).toBe("claude-sonnet-4-5")
    // Window key pinned to the 1M variant (drives compaction against 1M, not 200k).
    expect(adapter.contextWindowKey).toBe("claude-sonnet-4-5-1m")
    const headers = (adapter as unknown as { client: { _options?: { defaultHeaders?: unknown } } })
      .client._options?.defaultHeaders as Record<string, string> | undefined
    expect(headers?.["anthropic-beta"]).toBe(CONTEXT_1M_BETA)
  })
})

describe("context-1m — PAIRED CONTROL (OFF ⇒ byte-identical, no header)", () => {
  // With no knob / no suffix the SDK client is built WITHOUT any defaultHeaders
  // (the adapter only passes `defaultHeaders` when a beta is present). RED if
  // the factory attached the beta unconditionally.
  test("plain eligible model, no knob ⇒ NO anthropic-beta default header", () => {
    const headers = clientDefaultHeaders("claude-sonnet-4-5")
    // Either the whole defaultHeaders object is absent, or the beta key is gone.
    expect(headers?.["anthropic-beta"]).toBeUndefined()
  })

  test("ineligible model + [1m] ⇒ suffix stripped, INACTIVE, no header, no window pin", () => {
    // claude-opus-4-8 has no `-1m` window variant ⇒ requesting 1M is a no-op.
    const adapter = createLLM(
      "anthropic",
      { model: "claude-opus-4-8[1m]" },
      KEY,
    ) as unknown as AnthropicAdapter
    expect(adapter.model).toBe("claude-opus-4-8")
    expect(adapter.contextWindowKey).toBeUndefined()
    const headers = (adapter as unknown as { client: { _options?: { defaultHeaders?: unknown } } })
      .client._options?.defaultHeaders as Record<string, string> | undefined
    expect(headers?.["anthropic-beta"]).toBeUndefined()
  })

  test("ON vs OFF client default headers DIFFER exactly by the 1M beta", () => {
    const on = clientDefaultHeaders("claude-sonnet-4-5", { QUANTA_CONTEXT_1M: "1" })
    const off = clientDefaultHeaders("claude-sonnet-4-5")
    expect(on?.["anthropic-beta"]).toBe(CONTEXT_1M_BETA)
    expect(off?.["anthropic-beta"]).toBeUndefined()
  })
})
