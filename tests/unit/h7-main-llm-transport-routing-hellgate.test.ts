/**
 * ★ CONTRACT — H7 / ADR-0139 MAIN-AGENT transport SELECTION + ROUTING (the
 * previously-MISSING reachability layer).
 *
 * Before this wire, `createMulticloudLLM` + the H7 rotating-credential injection
 * were a fully-tested seam that NOTHING in the main agent path reached: the CLI's
 * `buildLLM` resolved only the four legacy vendor `Provider`s, so the entire
 * bedrock/vertex/foundry + rotation path was LIVE-BUT-UNREACHABLE by config.
 * `selectLlmTransport` + `buildMainLLMCore` are the surface-agnostic
 * SELECTION/ROUTING layer that closes that gap. This battery proves:
 *
 *   (a) DEFAULT-OFF BYTE-IDENTITY — no `QUANTA_LLM_TRANSPORT`, no cloud env
 *       signal ⇒ selection is `legacy` ⇒ `buildMainLLMCore` builds the SAME
 *       vendor adapter `buildLLMCore` would (provider tag + missing-key throw
 *       preserved). The credential input is NEVER consulted on this path.
 *   (b) SELECTION — explicit `QUANTA_LLM_TRANSPORT=bedrock` AND the env
 *       precedence ladder (`ANTHROPIC_VERTEX_BASE_URL`) both route to the
 *       multicloud path; explicit knob wins over a conflicting env signal.
 *   (c) ROUTING + H7 ROTATION reaches the cloud adapter END-TO-END — a
 *       configured + TRUSTED refresh command shells BEFORE the provider create
 *       on the routed `.stream()` (refresh ≺ create).
 *   (d) FAIL-CLOSED TRUST — the same config with `isTrusted:()=>false` (the
 *       `QUANTA_LLM_CREDENTIAL_TRUSTED` attestation unset) NEVER shells and
 *       surfaces a typed `untrusted` decline on `.stream()`.
 *   (e) UNKNOWN explicit id ⇒ multicloud (lazy `provider-unsupported`), NOT a
 *       silent fall-back to the vendor path (operator typo surfaces loudly).
 *   (f) NO-LEAK — the rotated secret never enters an emitted event nor the
 *       untrusted-decline error message on the routed path.
 */
import { describe, expect, test } from "bun:test"
import { CredentialHelperError, type ShellExecResult } from "@/llm/credential-helper"
import { MissingApiKeyError } from "@/llm/factory"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import {
  buildLLMCore,
  buildMainLLMCore,
  type CredentialSourceInput,
  type MainLlmAssembleInput,
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

const SECRET = "MAIN-ROUTE-SECRET-2a8f"

const makeTimeline = () => {
  const order: string[] = []
  const shellExec = async (command: string): Promise<ShellExecResult> => {
    order.push(`shell:${command}`)
    return { stdout: SECRET, stderr: SECRET, exitCode: 0 }
  }
  const make = () => ({
    messages: {
      async create() {
        order.push("create")
        return fakeStream() as AsyncIterable<never>
      },
    },
  })
  return { order, shellExec, bedrockClientFactory: make, vertexClientFactory: make }
}

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Off credential — all four H7 knobs unset, fail-closed predicate. */
const offCredential = (): CredentialSourceInput => ({
  apiKeyHelper: undefined,
  apiKeyHelperTtlMs: undefined,
  awsAuthRefresh: undefined,
  gcpAuthRefresh: undefined,
  isTrusted: () => false,
})

describe("selectLlmTransport — reuses the registry precedence ladder", () => {
  test("no knob, no cloud env ⇒ legacy (byte-identical vendor path)", () => {
    expect(selectLlmTransport({ transport: undefined, env: {} })).toEqual({ kind: "legacy" })
  })

  test("explicit QUANTA_LLM_TRANSPORT=default ⇒ legacy", () => {
    expect(selectLlmTransport({ transport: "default", env: {} })).toEqual({ kind: "legacy" })
  })

  test("explicit QUANTA_LLM_TRANSPORT=bedrock ⇒ multicloud(bedrock)", () => {
    expect(selectLlmTransport({ transport: "bedrock", env: {} })).toEqual({
      kind: "multicloud",
      providerId: "bedrock",
    })
  })

  test("env ANTHROPIC_VERTEX_BASE_URL (no explicit knob) ⇒ multicloud(vertex)", () => {
    expect(
      selectLlmTransport({
        transport: undefined,
        env: { ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example" },
      }),
    ).toEqual({ kind: "multicloud", providerId: "vertex" })
  })

  test("explicit knob WINS over a conflicting env signal", () => {
    expect(
      selectLlmTransport({
        transport: "bedrock",
        env: { ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example" },
      }),
    ).toEqual({ kind: "multicloud", providerId: "bedrock" })
  })

  test("unknown explicit id ⇒ multicloud (loud lazy-throw), NOT a silent legacy fallback", () => {
    expect(selectLlmTransport({ transport: "typo-xyz", env: {} })).toEqual({
      kind: "multicloud",
      providerId: "typo-xyz",
    })
  })
})

describe("buildMainLLMCore — DEFAULT-OFF byte-identity (legacy path)", () => {
  test("legacy selection builds the SAME vendor adapter as buildLLMCore", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-x" }
    const routed: LLMPort = buildMainLLMCore({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      env,
      selection: { kind: "legacy" },
      credential: offCredential(),
    })
    const direct: LLMPort = buildLLMCore({ provider: "anthropic", model: "claude-sonnet-4-6", env })
    expect(routed.provider).toBe(direct.provider)
    expect(routed.provider).toBe("anthropic")
  })

  test("legacy path preserves the missing-key THROW (cli aborts loudly)", () => {
    expect(() =>
      buildMainLLMCore({
        provider: "anthropic",
        model: "m",
        env: {},
        selection: { kind: "legacy" },
        credential: offCredential(),
      }),
    ).toThrow(MissingApiKeyError)
  })

  test("legacy path NEVER consults the credential input (no shell even if knobs set)", () => {
    const t = makeTimeline()
    buildMainLLMCore({
      provider: "anthropic",
      model: "m",
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
      selection: { kind: "legacy" },
      credential: {
        ...offCredential(),
        awsAuthRefresh: "should-never-run",
        isTrusted: () => true,
        shellExec: t.shellExec,
      },
    })
    expect(t.order).toEqual([]) // legacy path built no cloud adapter, no shell
  })
})

/** Build a routed multicloud LLM with the faked cloud client injected via the
 *  test-only `multicloudOpts` seam. */
const routedBedrock = (
  credential: CredentialSourceInput,
  t: ReturnType<typeof makeTimeline>,
): LLMPort =>
  buildMainLLMCore({
    provider: "anthropic", // ignored on the multicloud branch
    model: "", // empty ⇒ transport default model
    env: {},
    selection: { kind: "multicloud", providerId: "bedrock" },
    credential,
    multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
  } satisfies MainLlmAssembleInput)

describe("buildMainLLMCore — ROUTING to multicloud + H7 rotation END-TO-END", () => {
  test("routed bedrock + TRUSTED refresh ⇒ shell runs BEFORE create (REACHABLE)", async () => {
    const t = makeTimeline()
    const llm = routedBedrock(
      {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => true,
        now: () => 0,
        shellExec: t.shellExec,
      },
      t,
    )
    expect(llm.transportId).toBe("bedrock")
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["shell:aws sso login", "create"]) // refresh ≺ create
  })

  test("FAIL-CLOSED: untrusted attestation ⇒ NO shell, typed untrusted decline, no create", async () => {
    const t = makeTimeline()
    const llm = routedBedrock(
      {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => false, // QUANTA_LLM_CREDENTIAL_TRUSTED unset
        now: () => 0,
        shellExec: t.shellExec,
      },
      t,
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

  test("KNOB-OFF on the routed path ⇒ multicloud adapter shells ZERO times", async () => {
    const t = makeTimeline()
    const llm = routedBedrock(
      { ...offCredential(), isTrusted: () => true, shellExec: t.shellExec },
      t,
    )
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["create"]) // no source built ⇒ no shell
  })
})

describe("buildMainLLMCore — NO-LEAK on the routed path", () => {
  test("rotated secret never appears in an emitted event (trusted success)", async () => {
    const t = makeTimeline()
    const llm = routedBedrock(
      {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => true,
        now: () => 0,
        shellExec: t.shellExec,
      },
      t,
    )
    const events = await drain(llm.stream(input))
    expect(JSON.stringify(events).includes(SECRET)).toBe(false)
  })

  test("untrusted decline message does NOT contain the secret", async () => {
    const t = makeTimeline()
    const llm = routedBedrock(
      {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => false,
        now: () => 0,
        shellExec: t.shellExec,
      },
      t,
    )
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message.includes(SECRET)).toBe(false)
  })
})
