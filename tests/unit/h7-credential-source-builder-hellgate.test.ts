/**
 * ★ CONTRACT — H7 rotating cloud credentials, COMPOSITION-ROOT KNOB-READ:
 *
 * Proves the FINAL composition-root step that makes the (already-live)
 * `createMulticloudLLM` credentialSource INJECTION SEAM live end-to-end. The
 * `@/runner/assemble/llm.ts` builder reads the four H7 knobs (mirrored off
 * `runtimeConfig()` by the surface), builds a TRUST-GATED `CredentialSource`
 * (real `runShell` + injected trust predicate + clock), and hands it to
 * `buildMulticloudLLMCore` → `createMulticloudLLM`.
 *
 *   (a) KNOB-ON + TRUSTED ⇒ a `CredentialSource` is built and the multicloud
 *       adapter refreshes via it BEFORE the provider `create` (refresh ≺ create).
 *   (b) KNOB-ON + UNTRUSTED ⇒ FAIL-CLOSED: the shell is NEVER invoked, a typed
 *       `CredentialHelperError({code:"untrusted"})` surfaces, the provider
 *       `create` is never reached, no crash.
 *   (c) NO-LEAK — the helper's stdout (a would-be secret) NEVER appears in the
 *       thrown error message nor in any emitted stream event.
 *   (d) KNOB-OFF ⇒ NO source built (`buildCredentialSource` returns `undefined`)
 *       AND the multicloud adapter shells ZERO times (byte-identical default-OFF).
 */
import { describe, expect, test } from "bun:test"
import { CredentialHelperError, type ShellExecResult } from "@/llm/credential-helper"
import type { StreamEvent, StreamInput } from "@/llm/types"
import {
  buildCredentialSource,
  buildMulticloudLLMCore,
  type CredentialSourceInput,
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

const SECRET = "SUPER-SECRET-ROTATED-CRED-builder-7c1d"

/** Timeline recorder + a shell that emits the SECRET (so we can prove it never
 *  leaks). The shell is the TEST SEAM injected via `credential.shellExec`. */
const makeTimeline = (shellResult?: () => { exitCode: number }) => {
  const order: string[] = []
  const shellExec = async (command: string): Promise<ShellExecResult> => {
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
  return { order, shellExec, bedrockClientFactory: make, vertexClientFactory: make }
}

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** Base credential input — knob-off (all undefined) + a fail-closed predicate. */
const offCredential = (): CredentialSourceInput => ({
  apiKeyHelper: undefined,
  apiKeyHelperTtlMs: undefined,
  awsAuthRefresh: undefined,
  gcpAuthRefresh: undefined,
  isTrusted: () => false,
})

describe("H7 builder — buildCredentialSource knob gating", () => {
  test("ALL knobs unset ⇒ returns undefined (no source built, default-OFF)", () => {
    expect(buildCredentialSource(offCredential())).toBeUndefined()
  })

  test("any one knob set ⇒ a source IS built", () => {
    const src = buildCredentialSource({
      ...offCredential(),
      awsAuthRefresh: "aws sso login",
      isTrusted: () => true,
      shellExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })
    expect(src).not.toBeUndefined()
  })
})

describe("H7 builder — knob-ON + TRUSTED ⇒ live refresh before create", () => {
  test("bedrock: refresh shell runs BEFORE provider create (refresh ≺ create)", async () => {
    const t = makeTimeline()
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => true,
        now: () => 0,
        shellExec: t.shellExec,
      },
    })
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["shell:aws sso login", "create"])
  })

  test("vertex: refresh('gcp') runs before create", async () => {
    const t = makeTimeline()
    const llm = buildMulticloudLLMCore({
      opts: {
        providerId: "vertex",
        auth: { gcpProjectId: "proj", gcpLocation: "us-east5" },
        vertexClientFactory: t.vertexClientFactory,
      },
      env: {},
      credential: {
        ...offCredential(),
        gcpAuthRefresh: "gcloud auth print-access-token",
        isTrusted: () => true,
        now: () => 0,
        shellExec: t.shellExec,
      },
    })
    await drain(llm.stream(input))
    expect(t.order).toEqual(["shell:gcloud auth print-access-token", "create"])
  })
})

describe("H7 builder — knob-ON + UNTRUSTED ⇒ FAIL-CLOSED", () => {
  test("untrusted workspace ⇒ shell NEVER invoked, typed untrusted error, no create, no crash", async () => {
    const t = makeTimeline()
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => false, // FAIL-CLOSED
        now: () => 0,
        shellExec: t.shellExec,
      },
    })
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    expect((caught as CredentialHelperError).code).toBe("untrusted")
    // The shell never ran and the provider create was never reached.
    expect(t.order).toEqual([])
  })
})

describe("H7 builder — NO-LEAK", () => {
  test("untrusted decline message does NOT contain the helper secret", async () => {
    const t = makeTimeline()
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => false,
        now: () => 0,
        shellExec: t.shellExec,
      },
    })
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message.includes(SECRET)).toBe(false)
  })

  test("a FAILING trusted refresh throws typed helper-failed WITHOUT the secret", async () => {
    const t = makeTimeline(() => ({ exitCode: 7 }))
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => true,
        now: () => 0,
        shellExec: t.shellExec,
      },
    })
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    expect((caught as CredentialHelperError).code).toBe("helper-failed")
    expect((caught as Error).message.includes(SECRET)).toBe(false)
    // refresh fails first ⇒ provider create never reached.
    expect(t.order.filter((o) => o === "create").length).toBe(0)
  })

  test("secret never appears in any emitted stream event (trusted success path)", async () => {
    const t = makeTimeline()
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: {
        ...offCredential(),
        awsAuthRefresh: "aws sso login",
        isTrusted: () => true,
        now: () => 0,
        shellExec: t.shellExec,
      },
    })
    const events = await drain(llm.stream(input))
    expect(JSON.stringify(events).includes(SECRET)).toBe(false)
  })
})

describe("H7 builder — KNOB-OFF byte-identity", () => {
  test("no knobs ⇒ no source built ⇒ multicloud adapter shells ZERO times", async () => {
    const t = makeTimeline()
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: { ...offCredential(), isTrusted: () => true, shellExec: t.shellExec },
    })
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["create"]) // no shell at all
  })

  test("TTL re-run (rotation) when DUE, throttled within window — not stale reuse", async () => {
    const t = makeTimeline()
    let now = 0
    const llm = buildMulticloudLLMCore({
      opts: { providerId: "bedrock", bedrockClientFactory: t.bedrockClientFactory },
      env: {},
      credential: {
        ...offCredential(),
        awsAuthRefresh: "rotate",
        apiKeyHelperTtlMs: 1000,
        isTrusted: () => true,
        now: () => now,
        shellExec: t.shellExec,
      },
    })
    await drain(llm.stream(input)) // t=0 ⇒ refresh
    now = 500
    await drain(llm.stream(input)) // within window ⇒ throttled
    now = 2000
    await drain(llm.stream(input)) // TTL elapsed ⇒ re-refresh (rotation)
    const shells = t.order.filter((o) => o.startsWith("shell:"))
    const creates = t.order.filter((o) => o === "create")
    expect(shells.length).toBe(2)
    expect(creates.length).toBe(3)
  })
})
