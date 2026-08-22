/**
 * ★ CONTRACT — H7 rotating cloud credentials, ADAPTER PRE-CALL E2E:
 *
 *   - When a `BedrockProviderAdapter` is built with a `credentialSource`, the
 *     adapter runs `refreshCloudCreds("aws")` BEFORE the (faked) provider
 *     `messages.create` call on every `stream()`. Ordering is asserted: the
 *     refresh shell command is observed BEFORE the client factory's create.
 *   - The TTL throttle holds ACROSS adapter calls: a second `stream()` within
 *     the TTL window does NOT re-run the refresh shell.
 *   - The NO-CONFIG path (adapter built WITHOUT a credentialSource) shells out
 *     ZERO times and behaves byte-identically (the faked stream still drains).
 *   - The same wiring is proven for the Vertex adapter ("gcp").
 *   - The refreshed creds value never appears in the adapter's emitted events.
 */
import { describe, expect, test } from "bun:test"
import { createCredentialSource, type ShellExecFn } from "@/llm/credential-helper"
import { type BedrockClientFactory, BedrockProviderAdapter } from "@/llm/providers/bedrock-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { type VertexClientFactory, VertexProviderAdapter } from "@/llm/providers/vertex-adapter"
import type { StreamEvent, StreamInput } from "@/llm/types"

const bedrockConfig = (): ProviderConfig => ({
  providerId: "bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  auth: {},
})

const vertexConfig = (): ProviderConfig => ({
  providerId: "vertex",
  model: "claude-3-5-sonnet-v2@20241022",
  auth: { gcpProjectId: "proj", gcpLocation: "us-east5" },
})

const input: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
}

/** A trivial valid raw stream so `mapRawEvent` produces events. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }
  yield { type: "message_stop" }
}

/** A timeline-recording shell + factory so we can assert refresh ≺ create. */
const makeTimeline = () => {
  const order: string[] = []
  const shell: ShellExecFn = async (command) => {
    order.push(`shell:${command}`)
    return { stdout: "", stderr: "", exitCode: 0 }
  }
  const bedrockFactory: BedrockClientFactory = () => ({
    messages: {
      async create() {
        order.push("create")
        return fakeStream() as AsyncIterable<never>
      },
    },
  })
  const vertexFactory: VertexClientFactory = () => ({
    messages: {
      async create() {
        order.push("create")
        return fakeStream() as AsyncIterable<never>
      },
    },
  })
  return { order, shell, bedrockFactory, vertexFactory }
}

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("H7 e2e — bedrock adapter pre-call refresh", () => {
  test("refresh runs BEFORE the provider create on each stream()", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 0, // frozen clock — every call is in the same TTL window
    })
    const adapter = new BedrockProviderAdapter(bedrockConfig(), {
      clientFactory: t.bedrockFactory,
      credentialSource: src,
    })
    const events = await drain(adapter.stream(input))
    expect(events.length).toBeGreaterThan(0)
    // refresh shell observed before the create.
    expect(t.order).toEqual(["shell:aws sso login", "create"])
  })

  test("TTL throttle holds ACROSS adapter calls (2nd stream skips refresh shell)", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      awsAuthRefresh: "refresh",
      apiKeyHelperTtlMs: 10_000,
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 100, // frozen — both calls inside the window
    })
    const adapter = new BedrockProviderAdapter(bedrockConfig(), {
      clientFactory: t.bedrockFactory,
      credentialSource: src,
    })
    await drain(adapter.stream(input))
    await drain(adapter.stream(input))
    const shellCalls = t.order.filter((o) => o.startsWith("shell:"))
    expect(shellCalls.length).toBe(1) // throttled across the two stream() calls
    const creates = t.order.filter((o) => o === "create")
    expect(creates.length).toBe(2) // but both calls still reached the provider
  })

  test("no credentialSource ⇒ ZERO shell calls, byte-identical drain", async () => {
    const t = makeTimeline()
    const adapter = new BedrockProviderAdapter(bedrockConfig(), {
      clientFactory: t.bedrockFactory,
      // no credentialSource
    })
    const events = await drain(adapter.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["create"]) // no shell at all
  })
})

describe("H7 e2e — vertex adapter pre-call refresh (gcp)", () => {
  test("refresh('gcp') runs before create; no-config path skips it", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      gcpAuthRefresh: "gcloud auth print-access-token",
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 0,
    })
    const adapter = new VertexProviderAdapter(vertexConfig(), {
      clientFactory: t.vertexFactory,
      credentialSource: src,
    })
    await drain(adapter.stream(input))
    expect(t.order).toEqual(["shell:gcloud auth print-access-token", "create"])

    // No-config sibling: a fresh adapter without a source never shells.
    const t2 = makeTimeline()
    const bare = new VertexProviderAdapter(vertexConfig(), { clientFactory: t2.vertexFactory })
    await drain(bare.stream(input))
    expect(t2.order).toEqual(["create"])
  })
})
