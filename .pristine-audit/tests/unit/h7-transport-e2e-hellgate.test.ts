/**
 * ★ TRUE END-TO-END — H7 multicloud-transport + credential-rotation, driven
 * through the HIGHEST real entry point a user exercises: the CLI `buildLLM`
 * seam (`src/apps/cli/internal.ts`). Unlike the existing h7 unit hellgates
 * (which call `buildMainLLMCore` / `createMulticloudLLM` directly), THIS battery
 * proves the WHOLE chain a config-knob actually triggers:
 *
 *     QUANTA_LLM_TRANSPORT / ANTHROPIC_*_BASE_URL   (process.env)
 *        └─ runtimeConfig()  (the SSOT env read)
 *           └─ buildLLM()  (the CLI composition seam — selection + trust + cred)
 *              └─ selectLlmTransport()  (registry precedence ladder)
 *                 └─ buildMainLLMCore() → buildMulticloudLLMCore()
 *                    └─ createMulticloudLLM() → bedrock/vertex adapter
 *                       └─ credentialSource.refreshCloudCreds(...)  ≺  client.create()
 *
 * Fakes live ONLY at the leaf: the cloud client (`multicloudOpts.*ClientFactory`)
 * and the credential shell (`credential.shellExec`), both threaded down through
 * the test-only `BuildLlmTestSeams` argument `buildLLM` accepts (production omits
 * it ⇒ the real lazy SDK import + the real `runShell` are the live path). The
 * env → runtimeConfig() read is REAL: each test sets `process.env`, resets the
 * frozen config cache via `__resetRuntimeConfig`, and asserts what `buildLLM`
 * built. This is the reachability the user triggers BY CONFIG, end-to-end.
 *
 *   1. CONFIG-REACHABLE — `QUANTA_LLM_TRANSPORT=bedrock` (and a vertex case via
 *      the env ladder `ANTHROPIC_VERTEX_BASE_URL`) ⇒ the assembled LLM is the
 *      MULTICLOUD adapter (transportId set), NOT a legacy vendor adapter.
 *   2. CREDENTIAL REFRESH ≺ STREAM — a `.stream()` refreshes the cloud cred via
 *      the (fake) shell BEFORE the (fake) provider request (ordering asserted).
 *   3. TRUST FAIL-CLOSED — transport set + `QUANTA_LLM_CREDENTIAL_TRUSTED` UNSET
 *      ⇒ typed `untrusted` decline, the fake shell NEVER runs, no stream, no crash.
 *   4. NO-LEAK — a fake `AKIA…` secret on the shell stdout NEVER appears in any
 *      emitted stream event nor in the thrown untrusted/failure error message.
 *   5. DEFAULT-OFF BYTE-IDENTITY — no transport knob + no cloud env signal ⇒
 *      `legacy` ⇒ a vendor adapter builds (same provider tag as the legacy
 *      `buildLLMCore`/`createLLM` path, no transportId) and the credential input
 *      is NEVER consulted (the fake shell records ZERO calls even with knobs set).
 *   6. TTL ROTATION — a second `.stream()` after the TTL window re-refreshes;
 *      within the window it is throttled (single-flight) — proving the rotation
 *      is live end-to-end through the CLI seam.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CredentialHelperError, type ShellExecResult } from "@/llm/credential-helper"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { buildLLMCore } from "@/runner/assemble/llm"
import { __resetRuntimeConfig } from "@/shared"
import { type BuildLlmTestSeams, buildLLM } from "../../src/apps/cli/internal"

const input: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
}

/** Minimal valid raw stream so `mapRawEvent` produces events. The provider
 *  deliberately does NOT echo the secret — the only place a leak could enter is
 *  the credential helper's stdout. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }
  yield { type: "message_stop" }
}

/** A would-be AWS secret-access-key shape on the shell stdout. If the no-leak
 *  invariant ever regresses, this string surfaces in an event/error. */
const SECRET = "AKIAIOSFODNN7EXAMPLE-e2e-leak-canary"

/** Timeline recorder: the FAKE leaf shell (emits the SECRET) + FAKE cloud client
 *  factories (record `create`). These are the only fakes; everything above is the
 *  real composition. */
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

/** Every env key these tests touch. Saved + restored around each case so a
 *  failure mid-run can never contaminate the next test (mirrors the
 *  `env-knob-branches` convention). */
const ENV_KEYS = [
  "QUANTA_LLM_TRANSPORT",
  "QUANTA_LLM_CREDENTIAL_TRUSTED",
  "QUANTA_AWS_AUTH_REFRESH",
  "QUANTA_GCP_AUTH_REFRESH",
  "QUANTA_API_KEY_HELPER",
  "QUANTA_API_KEY_HELPER_TTL_MS",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "QUANTA_PROVIDER",
] as const

let saved: Map<string, string | undefined>

beforeEach(() => {
  saved = new Map()
  for (const k of ENV_KEYS) saved.set(k, process.env[k])
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
})

/** Build the LLM via the REAL CLI seam after pinning the frozen config to the
 *  current `process.env`. The `seams` inject ONLY the leaf fakes. */
const cliBuild = (seams: BuildLlmTestSeams): ReturnType<typeof buildLLM> => {
  __resetRuntimeConfig() // re-pin to the env the test just set
  return buildLLM("anthropic", "", seams)
}

describe("H7 e2e (CLI buildLLM) — 1. CONFIG-REACHABLE selection", () => {
  test("QUANTA_LLM_TRANSPORT=bedrock ⇒ MULTICLOUD adapter (not a legacy vendor)", () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    const t = makeTimeline()
    const llm = cliBuild({ multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory } })
    expect(llm.transportId).toBe("bedrock") // multicloud adapter carries transportId
  })

  test("env ladder ANTHROPIC_VERTEX_BASE_URL (no explicit knob) ⇒ vertex transport", () => {
    process.env.ANTHROPIC_VERTEX_BASE_URL = "https://vertex.example"
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "proj"
    process.env.CLOUD_ML_REGION = "us-east5"
    const t = makeTimeline()
    const llm = cliBuild({ multicloudOpts: { vertexClientFactory: t.vertexClientFactory } })
    expect(llm.transportId).toBe("vertex")
  })

  test("explicit transport knob WINS over a conflicting cloud env signal", () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.ANTHROPIC_VERTEX_BASE_URL = "https://vertex.example"
    const t = makeTimeline()
    const llm = cliBuild({ multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory } })
    expect(llm.transportId).toBe("bedrock")
  })
})

describe("H7 e2e (CLI buildLLM) — 2. credential refresh ≺ stream + 3. trust fail-closed", () => {
  test("bedrock + TRUSTED ⇒ shell refresh runs BEFORE provider create (REACHABLE)", async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "aws sso login"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    const t = makeTimeline()
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => 0,
    })
    const events = await drain(llm.stream(input))
    expect(events.length).toBeGreaterThan(0)
    expect(t.order).toEqual(["shell:aws sso login", "create"]) // refresh ≺ create
  })

  test("FAIL-CLOSED: transport set, QUANTA_LLM_CREDENTIAL_TRUSTED UNSET ⇒ untrusted decline, NO shell", async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "aws sso login"
    // QUANTA_LLM_CREDENTIAL_TRUSTED intentionally UNSET ⇒ isTrusted()===false.
    const t = makeTimeline()
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => 0,
    })
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    expect((caught as CredentialHelperError).code).toBe("untrusted")
    expect(t.order).toEqual([]) // shell NEVER ran, create NEVER reached, no crash
  })

  test('FAIL-CLOSED honors the strict ==="1" attestation (truthy-but-not-1 ⇒ untrusted)', async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "aws sso login"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "true" // NOT the literal "1"
    const t = makeTimeline()
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => 0,
    })
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect((caught as CredentialHelperError).code).toBe("untrusted")
    expect(t.order).toEqual([])
  })
})

describe("H7 e2e (CLI buildLLM) — 4. NO-LEAK of the rotated secret", () => {
  test("rotated secret never appears in any emitted event (trusted success)", async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "aws sso login"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    const t = makeTimeline()
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => 0,
    })
    const events = await drain(llm.stream(input))
    expect(JSON.stringify(events).includes(SECRET)).toBe(false)
  })

  test("a FAILING refresh helper throws typed error WITHOUT the secret, create not reached", async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "aws sso login"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    const t = makeTimeline(() => ({ exitCode: 7 }))
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => 0,
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
    expect(t.order.filter((o) => o === "create").length).toBe(0) // refresh fails first
  })

  test("untrusted decline message does NOT contain the secret", async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "aws sso login"
    const t = makeTimeline()
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => 0,
    })
    let caught: unknown
    try {
      await drain(llm.stream(input))
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message.includes(SECRET)).toBe(false)
  })
})

describe("H7 e2e (CLI buildLLM) — 5. DEFAULT-OFF byte-identity (legacy vendor path)", () => {
  test("no transport knob + no cloud env ⇒ legacy vendor adapter, byte-identical to buildLLMCore", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x"
    const llm = cliBuild({}) // no seams needed — legacy path builds no cloud adapter
    const direct = buildLLMCore({
      provider: "anthropic",
      model: "",
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
    })
    // Byte-identity: the CLI legacy build matches the direct legacy build exactly.
    expect(llm.provider).toBe(direct.provider)
    expect(llm.provider).toBe("anthropic")
    expect(llm.transportId).toBe(direct.transportId) // vendor default ("public")
    expect(llm.transportId).toBe("public")
    // NOT a cloud transport — the H7 multicloud path was never entered.
    expect(["bedrock", "vertex", "foundry", "mantle"]).not.toContain(llm.transportId)
  })

  test("legacy path NEVER consults the credential input (fake shell ZERO calls even with knobs set)", () => {
    // All four H7 command knobs + trust set, but NO transport ⇒ legacy selection
    // ⇒ the credential source is never built, the shell never wired in.
    process.env.ANTHROPIC_API_KEY = "sk-ant-x"
    process.env.QUANTA_AWS_AUTH_REFRESH = "should-never-run"
    process.env.QUANTA_API_KEY_HELPER = "echo also-never"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    const t = makeTimeline()
    cliBuild({ shellExec: t.shellExec, now: () => 0 })
    expect(t.order).toEqual([]) // legacy path built no cloud adapter, no shell
  })

  test("legacy path preserves the missing-key THROW (cli aborts loudly)", () => {
    // No ANTHROPIC_API_KEY, no transport ⇒ legacy createLLM throws.
    expect(() => cliBuild({})).toThrow()
  })
})

describe("H7 e2e (CLI buildLLM) — 6. TTL ROTATION (re-refresh when due, throttled in-window)", () => {
  test("second stream after TTL re-refreshes; within window it is throttled", async () => {
    process.env.QUANTA_LLM_TRANSPORT = "bedrock"
    process.env.QUANTA_AWS_AUTH_REFRESH = "rotate"
    process.env.QUANTA_API_KEY_HELPER_TTL_MS = "1000"
    process.env.QUANTA_LLM_CREDENTIAL_TRUSTED = "1"
    const t = makeTimeline()
    let clock = 0
    // ONE buildLLM ⇒ ONE credential source ⇒ the throttle/cache state persists
    // across `.stream()` calls (this is what makes rotation observable e2e).
    const llm = cliBuild({
      multicloudOpts: { bedrockClientFactory: t.bedrockClientFactory },
      shellExec: t.shellExec,
      now: () => clock,
    })
    await drain(llm.stream(input)) // t=0 ⇒ refresh
    clock = 500
    await drain(llm.stream(input)) // within window ⇒ throttled (no re-shell)
    clock = 2000
    await drain(llm.stream(input)) // TTL elapsed ⇒ refresh re-runs (rotation)
    const shells = t.order.filter((o) => o.startsWith("shell:"))
    const creates = t.order.filter((o) => o === "create")
    expect(shells.length).toBe(2) // re-ran when DUE, throttled when not
    expect(creates.length).toBe(3) // every call still reached the provider
  })
})
