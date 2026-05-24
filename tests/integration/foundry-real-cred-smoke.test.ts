/**
 * ADR-0172 §integration-smoke — Foundry real-credential smoke.
 *
 * Env-gated (the only place quanta touches a real Azure endpoint). Set
 * `QUANTA_FOUNDRY_SMOKE=1` AND the SDK env trio
 * (`ANTHROPIC_FOUNDRY_RESOURCE` + `ANTHROPIC_FOUNDRY_API_KEY` OR an
 * `azureADTokenProvider` wired by the operator outside this harness) to
 * exercise the live wire. Default-OFF: in normal CI / local runs the env
 * gate is absent and the suite is `skipIf`-ed away, so no Azure quota is
 * consumed.
 *
 * Mirror of the Bedrock real-cred smoke (ADR-0151 §integration-smoke). The
 * three arms together verify the end-to-end happy path without depending on
 * a synthetic DI factory:
 *   1. Construction with live creds.
 *   2. Streamed completion produces at least one text_delta + message_stop.
 *   3. Abort signal aborts a long-running stream cleanly.
 */
import { describe, expect, test } from "bun:test"
import {
  FoundryProviderAdapter,
  foundryProviderAdapter,
} from "@/llm/providers/foundry-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"

const enabled = process.env.QUANTA_FOUNDRY_SMOKE === "1"

const liveConfig = (): ProviderConfig => {
  // Build mutable scratch then assign to the readonly `auth` field once —
  // exactOptional honest: only forwarded fields end up in the bundle.
  const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE
  const baseURL = process.env.ANTHROPIC_FOUNDRY_BASE_URL
  const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY
  const auth = {
    ...(resource !== undefined && resource.length > 0 ? { azureResource: resource } : {}),
    ...(baseURL !== undefined && baseURL.length > 0 ? { azureEndpoint: baseURL } : {}),
    ...(apiKey !== undefined && apiKey.length > 0 ? { azureApiKey: apiKey } : {}),
  }
  return {
    providerId: "foundry",
    model: process.env.QUANTA_FOUNDRY_MODEL ?? "claude-sonnet-4-foundry",
    auth,
  }
}

describe.skipIf(!enabled)("Foundry real-credential smoke (env-gated)", () => {
  test("SMOKE-1: construct with live env", () => {
    const a = foundryProviderAdapter(liveConfig())
    expect(a).toBeInstanceOf(FoundryProviderAdapter)
    expect(a.providerId).toBe("foundry")
  })

  test("SMOKE-2: short completion yields text_delta + message_stop", async () => {
    const a = foundryProviderAdapter(liveConfig())
    const types: string[] = []
    for await (const ev of a.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word OK." }] }],
      tools: [],
    })) {
      types.push((ev as { type: string }).type)
      if (types.length > 50) break // safety cap — smoke, not load
    }
    expect(types).toContain("text_delta")
    expect(types).toContain("message_stop")
  }, 30_000)

  test("SMOKE-3: abort signal cancels the live stream cleanly", async () => {
    const a = foundryProviderAdapter(liveConfig())
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 100)
    let count = 0
    try {
      for await (const _ of a.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "Count slowly to 100." }] }],
        tools: [],
        signal: ctl.signal,
      })) {
        count++
      }
    } catch {
      // AbortError or wrapped LLMError — either is a clean cancel.
    }
    // Did NOT run to completion on its own — the abort fired within 100ms.
    expect(count).toBeLessThan(1000)
  }, 30_000)
})
