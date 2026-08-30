/**
 * ★ CONTRACT — ADR-0163 Phase A wiring-proof (G7-02): the CLAUDE_CODE_USE_*
 * quartet + provider-conflict policy must be LIVE on the PRODUCTION resolve
 * path, not only inside the router unit.
 *
 * Production resolution runs through `resolveProvider` (registry) via
 * `selectLlmTransport` → `buildMainLLMCore` (the CLI's composition root,
 * `src/apps/cli/internal.ts`). Before this wire, `resolveProviderWithRouter`
 * (ADR-0163 Phase A) was built-but-never-called in production: the registry
 * honored `CLAUDE_CODE_USE_*` only for FOUNDRY/MANTLE, so
 * `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` silently fell through to the public
 * api.anthropic.com path and the documented bedrock+vertex conflict throw
 * (ADR-0163 negative invariant 1) never fired in a real session. This battery
 * proves, at the production entry:
 *
 *   (a) CLAUDE_CODE_USE_BEDROCK=1 ⇒ multicloud(bedrock) selection AND the
 *       routed `.stream()` reaches the BEDROCK client end-to-end.
 *   (b) CLAUDE_CODE_USE_VERTEX=1 ⇒ multicloud(vertex).
 *   (c) Two truthy quartet keys ⇒ `ProviderConflictError` (typed, not a
 *       silent alphabetical pick) — surfaced from the production selector.
 *   (d) ADR-0163 precedence: CLAUDE_CODE_USE_* truthy BEATS
 *       `ANTHROPIC_*_BASE_URL` non-empty; explicit caller id beats both.
 *   (e) PAIRED CONTROL — no quartet key set ⇒ byte-identical resolution to
 *       today (legacy selection on empty env; URL-key ladder untouched).
 */
import { describe, expect, test } from "bun:test"
import { ProviderConflictError } from "@/llm/provider-router"
import { resolveProvider } from "@/llm/providers/registry"
import type { StreamEvent, StreamInput } from "@/llm/types"
import {
  buildMainLLMCore,
  type CredentialSourceInput,
  selectLlmTransport,
} from "@/runner/assemble/llm"

const input: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
}

async function* fakeStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }
  yield { type: "message_stop" }
}

const makeTimeline = () => {
  const order: string[] = []
  const make = (tag: string) => () => ({
    messages: {
      async create() {
        order.push(`create:${tag}`)
        return fakeStream() as AsyncIterable<never>
      },
    },
  })
  return { order, bedrockClientFactory: make("bedrock"), vertexClientFactory: make("vertex") }
}

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Off credential — all four H7 knobs unset (no source built ⇒ zero shells). */
const offCredential = (): CredentialSourceInput => ({
  apiKeyHelper: undefined,
  apiKeyHelperTtlMs: undefined,
  awsAuthRefresh: undefined,
  gcpAuthRefresh: undefined,
  isTrusted: () => false,
})

describe("CLAUDE_CODE_USE_* quartet — production wiring (ADR-0163 Phase A)", () => {
  test("HELL-W1: CLAUDE_CODE_USE_BEDROCK=1 ⇒ multicloud(bedrock) at the production selector", () => {
    expect(
      selectLlmTransport({ transport: undefined, env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
    ).toEqual({ kind: "multicloud", providerId: "bedrock" })
  })

  test("HELL-W2: CLAUDE_CODE_USE_VERTEX=true ⇒ multicloud(vertex)", () => {
    expect(
      selectLlmTransport({ transport: undefined, env: { CLAUDE_CODE_USE_VERTEX: "true" } }),
    ).toEqual({ kind: "multicloud", providerId: "vertex" })
  })

  test("HELL-W3: end-to-end — CLAUDE_CODE_USE_BEDROCK=1 routes .stream() to the BEDROCK client", async () => {
    const env = { CLAUDE_CODE_USE_BEDROCK: "1" }
    const t = makeTimeline()
    const selection = selectLlmTransport({ transport: undefined, env })
    const llm = buildMainLLMCore({
      provider: "anthropic",
      model: "",
      env,
      selection,
      credential: offCredential(),
      multicloudOpts: {
        bedrockClientFactory: t.bedrockClientFactory,
        vertexClientFactory: t.vertexClientFactory,
      },
    })
    await drain(llm.stream(input))
    expect(t.order).toEqual(["create:bedrock"])
  })

  test("HELL-W4: two truthy quartet keys ⇒ ProviderConflictError from the production selector", () => {
    expect(() =>
      selectLlmTransport({
        transport: undefined,
        env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "true" },
      }),
    ).toThrow(ProviderConflictError)
  })

  test("HELL-W5: conflict throws at the registry too (both call sites share one ladder)", () => {
    expect(() =>
      resolveProvider(undefined, { CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_MANTLE: "yes" }),
    ).toThrow(ProviderConflictError)
  })

  test("HELL-P1: ADR-0163 precedence — CLAUDE_CODE_USE_VERTEX beats ANTHROPIC_BEDROCK_BASE_URL", () => {
    const env = {
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
    }
    expect(resolveProvider(undefined, env).id).toBe("vertex")
  })

  test("HELL-P2: explicit caller id beats the quartet", () => {
    expect(resolveProvider("vertex", { CLAUDE_CODE_USE_BEDROCK: "1" }).id).toBe("vertex")
  })

  test("HELL-C1: paired control — no quartet key ⇒ legacy selection (byte-identical)", () => {
    expect(selectLlmTransport({ transport: undefined, env: {} })).toEqual({ kind: "legacy" })
  })

  test("HELL-C2: paired control — falsy quartet values do NOT select nor conflict", () => {
    const env = { CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "" }
    expect(resolveProvider(undefined, env).id).toBe("default")
  })

  test("HELL-C3: paired control — URL-key ladder untouched (bedrock URL still wins over vertex URL)", () => {
    const env = {
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
    }
    expect(resolveProvider(undefined, env).id).toBe("bedrock")
  })
})
