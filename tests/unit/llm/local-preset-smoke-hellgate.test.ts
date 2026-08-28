/**
 * HELLGATE — RFC05-3 D2 local-OSS presets, the DETERMINISTIC half.
 *
 * The Ollama / LM Studio presets are config sugar over the RFC05-0 endpoint
 * schema — `wireApi:"chat"`, `networkPolicy:"loopback_local"`, no auth. A
 * non-loopback base URL under the preset is refused by the RFC05-1 network
 * policy (the preset cannot reach a remote host).
 *
 * WHERE THE LIVE SMOKE LIVES NOW
 * ------------------------------
 * The half that drives the REAL `OpenAIAdapter` against a locally-running Ollama
 * moved to the opt-in real-toolchain lane:
 * `tests/unit/llm/local-preset-live-real-e2e.test.ts`, run by
 * `bun run test:real-toolchain`. Its cost is a real LLM inference — measured
 * between 7.4s and 151.4s for the SAME test and model depending only on machine
 * load, the 151.4s run being a RED against its own 160s cap — so no blocking
 * suite can hold it without flaking, and the per-test unit speed budget
 * (`tools/dev/unit-speed-budget.json`, 8,529ms) cannot be met by any of those
 * numbers. Without the env it is a VISIBLE skip, never a faked pass.
 */

import { describe, expect, test } from "bun:test"
import { buildEndpointFetch, localEndpointPreset } from "@/llm/endpoint-transport"
import { SsrfGuardError } from "@/shared/net/ssrf"

describe("RFC05-3 local preset sugar (deterministic)", () => {
  test("ollama preset ⇒ loopback chat profile, no auth", () => {
    const ep = localEndpointPreset("ollama", "llama3.1:8b")
    expect(ep.baseUrl).toBe("http://127.0.0.1:11434/v1")
    expect(ep.wireApi).toBe("chat")
    expect(ep.networkPolicy).toBe("loopback_local")
    expect(ep.authRef).toBeUndefined()
    expect(ep.headerRefs).toBeUndefined()
  })

  test("lmstudio preset ⇒ loopback chat profile on 1234", () => {
    const ep = localEndpointPreset("lmstudio", "some-local-model")
    expect(ep.baseUrl).toBe("http://127.0.0.1:1234/v1")
    expect(ep.networkPolicy).toBe("loopback_local")
  })

  test("a NON-loopback base-URL override is refused by the network policy at fetch time", async () => {
    // RED-ON-INJECTION: a preset must stay loopback-only; overriding the base URL
    // to a remote host cannot smuggle the request out.
    const ep = localEndpointPreset("ollama", "m", "http://93.184.216.34:11434/v1")
    const guarded = buildEndpointFetch(
      {
        id: "ollama",
        baseUrl: ep.baseUrl,
        wireApi: "chat",
        model: "m",
        networkPolicy: ep.networkPolicy,
        headers: {},
        query: {},
      },
      {
        resolveHost: async () => ["93.184.216.34"],
        inner: (async () => new Response("")) as unknown as typeof fetch,
      },
    )
    await expect(guarded(`${ep.baseUrl}/chat/completions`)).rejects.toThrow(SsrfGuardError)
  })
})
