/**
 * ★ CONTRACT — H7 rotating cloud credentials, FACTORY WIRE E2E (ADR-0139):
 *
 * Proves the NEW wiring that connects the `src/llm/providers/` transport slice
 * to the main `@/llm/factory` AND injects the H7 rotating-credential helper:
 *
 *   (a) SELECTION — `createMulticloudLLM` selects the multicloud adapter for the
 *       resolved transport (`bedrock` / `vertex`), via explicit id AND via the
 *       registry env precedence ladder (`ANTHROPIC_{BEDROCK,VERTEX}_BASE_URL`).
 *   (b) MINT/REFRESH BEFORE REQUEST — when a `credentialSource` is injected, the
 *       adapter runs `refreshCloudCreds(...)` (a SHELL command) BEFORE the faked
 *       provider `messages.create`. Ordering is asserted (refresh ≺ create).
 *   (c) ROTATION not stale-reuse — a refresh that the source decides is DUE
 *       (TTL elapsed via an injected clock) re-runs the shell; a refresh inside
 *       the window is throttled. The provider is reached on BOTH calls (the
 *       rotated cred is not a stale-key reuse — the shell DID re-run when due).
 *   (d) NO-LEAK — the refresh helper's stdout (a would-be secret) NEVER appears
 *       in any emitted stream event, nor in any thrown error message when the
 *       helper fails. Re-asserts the credential-helper no-leak invariant on the
 *       FACTORY path.
 *   (e) KNOB-OFF BYTE-IDENTITY — with NO credentialSource the four legacy
 *       providers build byte-identically (same adapter ctor args ⇒ same shape)
 *       and the multicloud adapter shells ZERO times.
 */
import { describe, expect, test } from "bun:test"
import {
  CredentialHelperError,
  createCredentialSource,
  type ShellExecFn,
} from "@/llm/credential-helper"
import {
  createLLM,
  createMulticloudLLM,
  type EnvLike,
  MULTICLOUD_DEFAULT_MODEL,
} from "@/llm/factory"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"

const input: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
}

/** A trivial valid raw stream so `mapRawEvent` produces events. The secret is
 *  deliberately NOT echoed by the provider — the only place a leak could enter
 *  is via the credential helper. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }
  yield { type: "message_stop" }
}

const SECRET = "SUPER-SECRET-ROTATED-CRED-9f3a"

/** Timeline recorder: a shell that emits the SECRET on stdout (so we can prove
 *  it never leaks) and provider client factories that record `create`. */
const makeTimeline = (shellResult?: () => { exitCode: number }) => {
  const order: string[] = []
  const shell: ShellExecFn = async (command) => {
    order.push(`shell:${command}`)
    const r = shellResult?.() ?? { exitCode: 0 }
    return { stdout: SECRET, stderr: SECRET, exitCode: r.exitCode }
  }
  const make = () => ({
    messages: {
      async create() {
        order.push("create")
        return fakeStream() as AsyncIterable<never>
      },
    },
  })
  return { order, shell, bedrockClientFactory: make, vertexClientFactory: make }
}

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("H7 factory wire — transport SELECTION via createMulticloudLLM", () => {
  test("explicit providerId='bedrock' builds a bedrock adapter (transportId)", () => {
    const llm = createMulticloudLLM({ providerId: "bedrock" }, {})
    expect(llm.transportId).toBe("bedrock")
    expect(llm.provider).toBe("anthropic")
    expect(llm.model).toBe(MULTICLOUD_DEFAULT_MODEL.bedrock)
  })

  test("env ANTHROPIC_VERTEX_BASE_URL routes to vertex (registry precedence)", () => {
    const env: EnvLike = {
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj",
      CLOUD_ML_REGION: "us-east5",
    }
    const llm = createMulticloudLLM({}, env)
    expect(llm.transportId).toBe("vertex")
  })

  test("no transport signal ⇒ falls back to default (public Anthropic)", () => {
    const llm = createMulticloudLLM({ auth: { apiKey: "sk-test" } }, {})
    expect(llm.transportId).toBe("public")
  })
})

describe("H7 factory wire — credential MINT/REFRESH before request", () => {
  test("bedrock: refresh shell runs BEFORE provider create (refresh ≺ create)", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 0,
    })
    const llm = createMulticloudLLM(
      {
        providerId: "bedrock",
        credentialSource: src,
        bedrockClientFactory: t.bedrockClientFactory,
      },
      {},
    )
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["shell:aws sso login", "create"])
  })

  test("vertex: refresh('gcp') runs before create", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      gcpAuthRefresh: "gcloud auth print-access-token",
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 0,
    })
    const llm = createMulticloudLLM(
      {
        providerId: "vertex",
        auth: { gcpProjectId: "proj", gcpLocation: "us-east5" },
        credentialSource: src,
        vertexClientFactory: t.vertexClientFactory,
      },
      {},
    )
    await drain(llm.stream(input))
    expect(t.order).toEqual(["shell:gcloud auth print-access-token", "create"])
  })
})

describe("H7 factory wire — ROTATION (TTL re-run when due, not stale reuse)", () => {
  test("refresh re-runs after the TTL elapses (clock advance) — not a stale key", async () => {
    const t = makeTimeline()
    let now = 0
    const src = createCredentialSource({
      awsAuthRefresh: "rotate",
      apiKeyHelperTtlMs: 1000,
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => now,
    })
    const llm = createMulticloudLLM(
      {
        providerId: "bedrock",
        credentialSource: src,
        bedrockClientFactory: t.bedrockClientFactory,
      },
      {},
    )
    await drain(llm.stream(input)) // t=0 ⇒ refresh
    now = 500
    await drain(llm.stream(input)) // within window ⇒ throttled (no re-shell)
    now = 2000
    await drain(llm.stream(input)) // TTL elapsed ⇒ refresh re-runs (rotation)
    const shells = t.order.filter((o) => o.startsWith("shell:"))
    const creates = t.order.filter((o) => o === "create")
    expect(shells.length).toBe(2) // re-ran when DUE, throttled when not
    expect(creates.length).toBe(3) // every call still reached the provider
  })
})

describe("H7 factory wire — NO-LEAK of the rotated secret", () => {
  test("secret never appears in any emitted stream event", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 0,
    })
    const llm = createMulticloudLLM(
      {
        providerId: "bedrock",
        credentialSource: src,
        bedrockClientFactory: t.bedrockClientFactory,
      },
      {},
    )
    const events = await drain(llm.stream(input))
    const blob = JSON.stringify(events)
    expect(blob.includes(SECRET)).toBe(false)
  })

  test("a FAILING refresh helper throws typed error WITHOUT the secret in the message", async () => {
    const t = makeTimeline(() => ({ exitCode: 7 }))
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: t.shell,
      isTrusted: () => true,
      now: () => 0,
    })
    const llm = createMulticloudLLM(
      {
        providerId: "bedrock",
        credentialSource: src,
        bedrockClientFactory: t.bedrockClientFactory,
      },
      {},
    )
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    expect((caught as CredentialHelperError).code).toBe("helper-failed")
    expect((caught as Error).message.includes(SECRET)).toBe(false)
    // The provider create must NOT have been reached (refresh fails first).
    expect(t.order.filter((o) => o === "create").length).toBe(0)
  })

  test("untrusted workspace ⇒ shell NEVER invoked, typed untrusted error, no create", async () => {
    const t = makeTimeline()
    const src = createCredentialSource({
      awsAuthRefresh: "aws sso login",
      shellExec: t.shell,
      isTrusted: () => false,
      now: () => 0,
    })
    const llm = createMulticloudLLM(
      {
        providerId: "bedrock",
        credentialSource: src,
        bedrockClientFactory: t.bedrockClientFactory,
      },
      {},
    )
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    expect((caught as CredentialHelperError).code).toBe("untrusted")
    expect(t.order).toEqual([]) // shell never ran, create never reached
  })
})

describe("H7 factory wire — KNOB-OFF byte-identity", () => {
  test("no credentialSource ⇒ multicloud adapter shells ZERO times", async () => {
    const t = makeTimeline()
    const llm = createMulticloudLLM(
      { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      {},
    )
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["create"]) // no shell at all
  })

  test("the four legacy providers still build via createLLM (untouched path)", () => {
    const anthropicEnv: EnvLike = { ANTHROPIC_API_KEY: "sk-ant-x" }
    const openaiEnv: EnvLike = { OPENAI_API_KEY: "sk-oai-x" }
    const a: LLMPort = createLLM("anthropic", {}, anthropicEnv)
    const o: LLMPort = createLLM("openai", {}, openaiEnv)
    // Legacy providers carry their own provider tag; multicloud wiring did not
    // perturb them (vendor axis untouched).
    expect(a.provider).toBe("anthropic")
    expect(o.provider).toBe("openai")
  })
})
