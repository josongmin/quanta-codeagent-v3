/** B1 sampling LIVE wire — e2e hellgate at the `loadFeatures`/`internal.ts` seam.
 *
 *  Where the sibling `mcp-sampling-live-wire-hellgate` proves the `mcp-bridge`
 *  CONSUMER, this proves the surface PRODUCER: `loadFeatures` (the CLI feature
 *  loader the host bootstrap calls right after it builds the `LLMPort`) computes
 *  the advertise-iff-able wiring from ONE gate and threads it down such that the
 *  threaded `LLMPort` actually reaches an inbound `sampling/createMessage`.
 *
 *  Driven through `loadFeatures` directly with its injectable test seams (an MCP
 *  config via env, a scripted transport, and a forced-interactive consent
 *  prompter) — the closest seam to the real CLI boot that does not spawn a
 *  process or stand up a full REPL.
 *
 *   (A) knob ON + threaded LLM + interactive consent(allow): the loaded client
 *       advertises `sampling` AND an inbound request reaches the threaded LLM.
 *   (B) knob OFF: no advertisement + headless rejecter (byte-identical), LLM
 *       NEVER called — proving the gate, not just the handler.
 *   (C) knob ON but NO LLM threaded: sampling stays OFF (no inference to spend).
 *   (D) knob ON + LLM but NO interactive consent prompter: sampling stays OFF
 *       (an unattended run must not silently spend a remote server's tokens).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { ElicitationPrompterFactory } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ElicitationPrompter } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { MCP_SAMPLING_METHOD } from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"
import type { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"
import { loadFeatures } from "../../src/apps/cli/internal"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 64; i++) await Promise.resolve()
}

/** Yield to the macrotask queue so real async IO inside `loadFeatures` (the
 *  `Bun.file(...).text()` config read, then the client `start()` handshake)
 *  advances — microtask flushing alone cannot step past a file read. */
const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await flush()
}

class ScriptedTransport implements McpTransport {
  private messageHandler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    this.sent.push(payload as Record<string, unknown>)
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandler = handler
    return () => {
      this.messageHandler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.messageHandler?.(msg)
  }
}

const noopLog: StructuredLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as StructuredLogger

const fakeLlm = (): { llm: LLMPort; calls: () => number } => {
  let n = 0
  return {
    calls: () => n,
    llm: {
      model: "fake-model",
      stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        n += 1
        return (async function* () {
          yield { type: "text_delta", delta: "4" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        })()
      },
    },
  }
}

/** A consent prompter factory that answers `promptBoolean` with `answer` for
 *  EVERY context. Mirrors the production CLI prompter's per-context factory
 *  shape (the surface binds it per server / per sampling context). */
const consentFactory = (answer: boolean): ElicitationPrompterFactory => {
  const reject = async (): Promise<never> => {
    throw new Error("only promptBoolean")
  }
  const prompter: ElicitationPrompter = {
    promptBoolean: async () => ({ ok: true, value: answer }),
    promptString: reject,
    promptNumber: reject,
    promptInteger: reject,
    promptEnum: reject,
    promptMultiEnum: reject,
    promptSingleEnum: reject,
    promptUrl: reject,
  }
  return (_serverId: string) => prompter
}

const sampleParams = {
  messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
  systemPrompt: "You are a calculator.",
  maxTokens: 16,
}

// A one-server MCP config written to a temp file + pointed to via env so
// `readMcpConfig` yields exactly one server for the load.
let configPath: string
const savedEnv: Record<string, string | undefined> = {}

const setEnv = (k: string, v: string | undefined): void => {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeEach(async () => {
  configPath = `${process.cwd()}/.tmp-mcp-sampling-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  await Bun.write(configPath, JSON.stringify({ servers: [{ name: "s1", command: ["x"] }] }))
  setEnv("QUANTA_MCP_CONFIG", configPath)
})

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
  __resetRuntimeConfig()
  await Bun.file(configPath)
    .unlink()
    .catch(() => undefined)
})

/** Drive `loadFeatures` with the scripted transport; complete the handshake;
 *  return the live transport + the loaded `mcpClients` for teardown. */
const loadAndHandshake = async (
  transport: ScriptedTransport,
  opts: Parameters<typeof loadFeatures>[1],
): Promise<{ clients: { stop: () => Promise<void> }[] }> => {
  // The sampling knob is read via the cached `runtimeConfig()`; reset it AFTER
  // the test has set `QUANTA_MCP_SAMPLING` so the freshly-frozen snapshot sees it.
  __resetRuntimeConfig()
  const loadP = loadFeatures(noopLog, {
    ...opts,
    mcpTransportFor: () => transport,
  })
  // Wait (macrotask ticks) for the async config read + client `start()` to emit
  // `initialize`, answer it, then answer `tools/list`. Poll because the IO
  // boundary makes the exact tick non-deterministic.
  const waitFor = async (method: string): Promise<{ id: number } | undefined> => {
    for (let i = 0; i < 50; i++) {
      const m = transport.sent.find((s) => s.method === method) as { id: number } | undefined
      if (m !== undefined) return m
      await tick()
    }
    return undefined
  }
  const init = await waitFor("initialize")
  if (init !== undefined) {
    transport.emit({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-06-18" } })
  }
  const list = await waitFor("tools/list")
  if (list !== undefined) {
    transport.emit({ jsonrpc: "2.0", id: list.id, result: { tools: [] } })
  }
  const features = await loadP
  return { clients: features.mcpClients }
}

const initCaps = (t: ScriptedTransport): Record<string, unknown> => {
  const init = t.sent.find((m) => m.method === "initialize") as {
    params: { capabilities: Record<string, unknown> }
  }
  return init.params.capabilities
}

const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

describe("B1 e2e — loadFeatures threads the LLMPort to the inbound sampling handler", () => {
  it("(A) knob ON + LLM + interactive consent(allow) ⇒ advertises sampling + reaches the LLM", async () => {
    // Sampling is gated on BOTH knobs: the base capability set must be on
    // (`QUANTA_MCP_CAPS=full`) for any inbound capability, and the sampling
    // opt-in (`QUANTA_MCP_SAMPLING=1`) advertises it iff a handler is wired.
    setEnv("QUANTA_MCP_CAPS", "full")
    setEnv("QUANTA_MCP_SAMPLING", "1")
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const { clients } = await loadAndHandshake(transport, {
      llm,
      elicitationPrompterFor: consentFactory(true),
    })

    expect(initCaps(transport).sampling).toEqual({})

    transport.emit({ jsonrpc: "2.0", id: 42, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    expect(calls()).toBe(1) // the THREADED LLM was reached end-to-end
    const reply = lastSend(transport)
    expect(reply.id).toBe(42)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({
      role: "assistant",
      content: { type: "text", text: "4" },
      model: "fake-model",
      stopReason: "end_turn",
    })
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("B1 e2e — knob OFF (byte-identical default)", () => {
  it("(B) no advertisement + headless rejecter, LLM NEVER called", async () => {
    setEnv("QUANTA_MCP_SAMPLING", undefined)
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const { clients } = await loadAndHandshake(transport, {
      llm,
      elicitationPrompterFor: consentFactory(true),
    })

    expect("sampling" in initCaps(transport)).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 8, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const err = lastSend(transport).error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("no-handler")
    expect(calls()).toBe(0)
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("B1 e2e — knob ON but no LLM threaded", () => {
  it("(C) sampling stays OFF (no inference to spend)", async () => {
    setEnv("QUANTA_MCP_SAMPLING", "1")
    const transport = new ScriptedTransport()
    const { clients } = await loadAndHandshake(transport, {
      elicitationPrompterFor: consentFactory(true),
    })
    expect("sampling" in initCaps(transport)).toBe(false)
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("B1 e2e — sampling knob on but base caps off (inverse-drift guard)", () => {
  it("(E) QUANTA_MCP_SAMPLING=1 WITHOUT QUANTA_MCP_CAPS=full ⇒ sampling stays OFF (never a handler-without-advertisement)", async () => {
    setEnv("QUANTA_MCP_SAMPLING", "1")
    setEnv("QUANTA_MCP_CAPS", undefined)
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const { clients } = await loadAndHandshake(transport, {
      llm,
      elicitationPrompterFor: consentFactory(true),
    })
    expect("sampling" in initCaps(transport)).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 11, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()
    const err = lastSend(transport).error as { code: number; message: string }
    expect(err.message).toContain("no-handler")
    expect(calls()).toBe(0)
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("B1 e2e — knob ON + LLM but no interactive consent prompter", () => {
  it("(D) sampling stays OFF (unattended run must not silently spend tokens)", async () => {
    setEnv("QUANTA_MCP_SAMPLING", "1")
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    // No `elicitationPrompterFor` injected AND stdin is not a TTY in the test
    // runner ⇒ the production factory is `undefined` ⇒ no consent ⇒ OFF.
    const { clients } = await loadAndHandshake(transport, { llm })
    expect("sampling" in initCaps(transport)).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 9, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()
    const err = lastSend(transport).error as { code: number; message: string }
    expect(err.message).toContain("no-handler")
    expect(calls()).toBe(0)
    await Promise.all(clients.map((c) => c.stop()))
  })
})
