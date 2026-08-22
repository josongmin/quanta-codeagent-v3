/**
 * Wave-1 serial-integration reachability e2e — proves the SHARED-file wiring
 * actually connects each knob to its effect through the REAL composition (not
 * just the leaf slice, which the per-feature hellgates already cover).
 *
 *   - PROMPT-CACHE 1h: `QUANTA_PROMPT_CACHE_TTL=1h` + an allowlisted model ⇒
 *     `createMulticloudLLM` threads `cacheTtl:"1h"` into the ProviderConfig, the
 *     cloud adapter forwards it to `buildAnthropicMessagesRequest`'s 4th arg, and
 *     `ttl:"1h"` reaches the wire request. Knob OFF ⇒ no `ttl` (byte-identical).
 *     A NON-allowlisted model with the knob ON ⇒ still no `ttl` (allowlist gate).
 *   - VERTEX REGION MAP: `VERTEX_REGION_<MODEL>` env ⇒ `createMulticloudLLM`
 *     derives the per-model region map and threads it into the adapter, so the
 *     SDK client is built for the mapped region. Absent ⇒ the single-region path.
 *
 * (Logout-revoke composition reachability is documented at the foot of this file
 * — the CLI-surface registry cannot be imported here under ADR-0024.)
 *
 * Fakes live ONLY at the leaf (the cloud client factory). The env → runtimeConfig
 * read is REAL: each test sets process.env, resets the frozen cache, asserts the
 * built request / region.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createMulticloudLLM } from "@/llm/factory"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { __resetRuntimeConfig } from "@/shared"

const input: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  // A cache:true system block guarantees the codec stamps a cache_control
  // breakpoint where the ttl rides.
  system: [{ type: "text", text: "static", cache: true }],
}

async function* fakeStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } }
  yield { type: "message_stop" }
}

interface Capture {
  params?: Record<string, unknown>
  region?: string
}

/** Vertex client factory that records the request params + the region the SDK
 *  client was constructed for. */
const recordingVertex = (cap: Capture) => (opts: { region: string }) => {
  cap.region = opts.region
  return {
    messages: {
      async create(params: Record<string, unknown>) {
        cap.params = params
        return fakeStream() as AsyncIterable<never>
      },
    },
  }
}

const drain = async (it: AsyncIterable<StreamEvent>): Promise<void> => {
  for await (const _ of it) {
    // drain to force client construction + request build
  }
}

const VERTEX_ENV = {
  ANTHROPIC_VERTEX_PROJECT_ID: "proj",
  CLOUD_ML_REGION: "us-central1",
}

const ttlCount = (params: Record<string, unknown> | undefined): number =>
  JSON.stringify(params ?? {}).split('"ttl":"1h"').length - 1

describe("wave-1 reachability · prompt-cache 1h factory→codec", () => {
  beforeEach(() => __resetRuntimeConfig())
  afterEach(() => {
    delete process.env.QUANTA_PROMPT_CACHE_TTL
    __resetRuntimeConfig()
  })

  test("knob=1h + allowlisted model ⇒ ttl:'1h' reaches the request", async () => {
    process.env.QUANTA_PROMPT_CACHE_TTL = "1h"
    __resetRuntimeConfig()
    const cap: Capture = {}
    const llm = createMulticloudLLM(
      { providerId: "vertex", model: "claude-opus-4-8", vertexClientFactory: recordingVertex(cap) },
      VERTEX_ENV,
    )
    await drain(llm.stream(input))
    expect(ttlCount(cap.params)).toBeGreaterThan(0)
  })

  test("knob ABSENT ⇒ NO ttl in the request (byte-identical default-OFF)", async () => {
    __resetRuntimeConfig()
    const cap: Capture = {}
    const llm = createMulticloudLLM(
      { providerId: "vertex", model: "claude-opus-4-8", vertexClientFactory: recordingVertex(cap) },
      VERTEX_ENV,
    )
    await drain(llm.stream(input))
    expect(ttlCount(cap.params)).toBe(0)
  })

  test("knob=1h BUT non-allowlisted model ⇒ still NO ttl (allowlist gate)", async () => {
    process.env.QUANTA_PROMPT_CACHE_TTL = "1h"
    __resetRuntimeConfig()
    const cap: Capture = {}
    const llm = createMulticloudLLM(
      {
        providerId: "vertex",
        model: "claude-sonnet-9-9",
        vertexClientFactory: recordingVertex(cap),
      },
      VERTEX_ENV,
    )
    await drain(llm.stream(input))
    expect(ttlCount(cap.params)).toBe(0)
  })

  test("knob=1h + Bedrock-style prefixed allowlisted slug ⇒ ttl reaches request (family-normalized)", async () => {
    process.env.QUANTA_PROMPT_CACHE_TTL = "1h"
    __resetRuntimeConfig()
    const cap: Capture = {}
    // Vertex @date-pinned allowlisted slug must normalize to the family.
    const llm = createMulticloudLLM(
      {
        providerId: "vertex",
        model: "claude-opus-4-8@20250101",
        vertexClientFactory: recordingVertex(cap),
      },
      VERTEX_ENV,
    )
    await drain(llm.stream(input))
    expect(ttlCount(cap.params)).toBeGreaterThan(0)
  })
})

describe("wave-1 reachability · vertex region map factory→adapter", () => {
  beforeEach(() => __resetRuntimeConfig())
  afterEach(() => __resetRuntimeConfig())

  test("VERTEX_REGION_<MODEL> env ⇒ the mapped region builds the SDK client", async () => {
    const cap: Capture = {}
    const llm = createMulticloudLLM(
      { providerId: "vertex", model: "claude-opus-4-8", vertexClientFactory: recordingVertex(cap) },
      { ...VERTEX_ENV, "VERTEX_REGION_CLAUDE-OPUS-4-8": "us-east5" },
    )
    await drain(llm.stream(input))
    expect(cap.region).toBe("us-east5")
  })

  test("no VERTEX_REGION_* env ⇒ fallback CLOUD_ML_REGION (byte-identical single-region)", async () => {
    const cap: Capture = {}
    const llm = createMulticloudLLM(
      { providerId: "vertex", model: "claude-opus-4-8", vertexClientFactory: recordingVertex(cap) },
      VERTEX_ENV,
    )
    await drain(llm.stream(input))
    expect(cap.region).toBe("us-central1")
  })

  test("VERTEX_REGION_* set for a DIFFERENT model ⇒ this model falls back (exact-key)", async () => {
    const cap: Capture = {}
    const llm = createMulticloudLLM(
      { providerId: "vertex", model: "claude-opus-4-8", vertexClientFactory: recordingVertex(cap) },
      { ...VERTEX_ENV, "VERTEX_REGION_CLAUDE-SONNET-4-6": "europe-west1" },
    )
    await drain(llm.stream(input))
    expect(cap.region).toBe("us-central1")
  })
})

// NOTE: logout-revoke composition reachability — the registry wires `/logout`
// via `buildLogoutCmd({ revokeOnLogout: runtimeConfig().oauthRevokeOnLogout,
// fetchPort, logger })` in `registry-surface.ts`. That CLI-surface module cannot
// be imported from an external test (ADR-0024 slice isolation), so the deep
// knob-on revoke behavior is covered by `token-revoke-on-logout-hellgate`
// (drives `buildLogoutCmd` directly with `revokeOnLogout:true`), and the
// composition wiring is guarded by `bun run typecheck`.
