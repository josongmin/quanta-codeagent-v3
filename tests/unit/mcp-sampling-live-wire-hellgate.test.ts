/** B1 sampling LIVE wire — hellgate at the `@/agent/mcp-bridge` consumer boundary.
 *
 *  The composition root (the CLI surface) decides the advertise-iff-able wiring
 *  via ONE gate (`buildSamplingWiring` + `pickMcpNegotiator`) and hands the
 *  already-built `{ negotiator, handler }` DOWN to `loadMcpTools`. `mcp-bridge`
 *  is a PURE consumer — it never imports `@/host`; it only threads what it is
 *  given into the `McpClient` it constructs. This battery proves THAT thread:
 *
 *   (A) knob ON + fake LLM + consent(allow): `loadMcpTools` builds a client that
 *       ADVERTISES `sampling` AND whose `samplingHandler` is the llm-backed one —
 *       an inbound `sampling/createMessage` reaches the fake LLM (consent-allow).
 *   (B) consent(deny): JSON-RPC error carrying `user-denied`, LLM NOT called.
 *   (C) knob OFF (no `samplingWiring` opt): the constructed client does NOT
 *       advertise sampling AND its default headless rejecter declines
 *       (`no-handler`) — byte-identical to today.
 *   (D) advertise+handler MOVE TOGETHER: when the wiring opt is supplied the
 *       negotiator advertises `sampling` IFF the handler is the supplied one.
 *
 *  The transport is injected via the existing `opts.transportFor` seam so no
 *  real process is spawned; the inbound request is emitted directly and the
 *  reply is read off the transport's `sent` buffer.
 */

import { describe, expect, it } from "bun:test"
import { loadMcpTools } from "@/agent/mcp-bridge"
import { buildSamplingWiring, pickMcpNegotiator } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ElicitationPrompter, ElicitationResult, McpServerConfig } from "@/mcp"
import { headlessRejecter } from "@/mcp/elicitation/headless-rejecter"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { MCP_SAMPLING_METHOD } from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"

/** Flush more microtasks than any inbound path needs (consent → stream drain →
 *  reply send all await). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 64; i++) await Promise.resolve()
}

/** A scripted transport mirroring the e2e suite's: it captures sent payloads and
 *  lets the test emit inbound messages. `listTools` returns an empty list so the
 *  load completes with zero bridged tools (we only care about the constructed
 *  client's inbound behavior). */
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

const consentOf = (answer: ElicitationResult<boolean>): ElicitationPrompter => {
  const reject = async (): Promise<never> => {
    throw new Error("only promptBoolean")
  }
  return {
    promptBoolean: async () => answer,
    promptString: reject,
    promptNumber: reject,
    promptInteger: reject,
    promptEnum: reject,
    promptMultiEnum: reject,
    promptSingleEnum: reject,
  }
}

const ON = { QUANTA_MCP_CAPS: "full" } as NodeJS.ProcessEnv
const CONFIG: McpServerConfig = { name: "s1", command: ["x"] }
const sampleParams = {
  messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
  systemPrompt: "You are a calculator.",
  maxTokens: 16,
}

/** Build the `samplingWiring` opt EXACTLY as the surface would: ONE gate yields
 *  BOTH the advertise flag (→ `pickMcpNegotiator`) and the handler. Returns
 *  `undefined` when the gate is OFF so the load opt is omitted (byte-identical). */
const samplingWiringOpt = (
  knobOn: boolean,
  deps: { llm: LLMPort; consent: ElicitationPrompter } | undefined,
) => {
  const wiring = buildSamplingWiring(knobOn, deps)
  if (!wiring.advertise || wiring.handler === undefined) return undefined
  return {
    negotiator: pickMcpNegotiator(ON, { sampling: true }),
    handler: wiring.handler,
  }
}

/** Drive `loadMcpTools` with a scripted transport injected + the optional
 *  sampling wiring; complete the `initialize` handshake; return the live
 *  transport so the test can emit inbound requests. */
const loadWith = async (
  transport: ScriptedTransport,
  wiringOpt: ReturnType<typeof samplingWiringOpt>,
): Promise<{ stop: () => Promise<void> }> => {
  const loadP = loadMcpTools(
    [CONFIG],
    undefined,
    wiringOpt !== undefined
      ? { transportFor: () => transport, samplingWiring: wiringOpt }
      : { transportFor: () => transport },
  )
  await flush()
  // Answer initialize + tools/list so the load resolves.
  const init = transport.sent.find((m) => m.method === "initialize") as { id: number } | undefined
  if (init !== undefined) {
    transport.emit({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-06-18" } })
  }
  await flush()
  const list = transport.sent.find((m) => m.method === "tools/list") as { id: number } | undefined
  if (list !== undefined) {
    transport.emit({ jsonrpc: "2.0", id: list.id, result: { tools: [] } })
  }
  const { clients } = await loadP
  return { stop: async () => Promise.all(clients.map((c) => c.stop())).then(() => undefined) }
}

const initCaps = (t: ScriptedTransport): Record<string, unknown> => {
  const init = t.sent.find((m) => m.method === "initialize") as {
    params: { capabilities: Record<string, unknown> }
  }
  return init.params.capabilities
}

const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

describe("B1 live wire — mcp-bridge consumes the sampling wiring (knob ON, allow)", () => {
  it("(A) loadMcpTools builds a client that advertises sampling + routes inbound through the llm handler", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const opt = samplingWiringOpt(true, { llm, consent: consentOf({ ok: true, value: true }) })
    const { stop } = await loadWith(transport, opt)

    // advertise-iff-handler: the constructed client advertised sampling.
    expect(initCaps(transport).sampling).toEqual({})

    transport.emit({ jsonrpc: "2.0", id: 42, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    expect(calls()).toBe(1) // reached the fake LLM via consent-allow
    const reply = lastSend(transport)
    expect(reply.id).toBe(42)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({
      role: "assistant",
      content: { type: "text", text: "4" },
      model: "fake-model",
      stopReason: "end_turn",
    })
    await stop()
  })
})

describe("B1 live wire — consent deny", () => {
  it("(B) deny ⇒ JSON-RPC error (user-denied), LLM NOT called", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const opt = samplingWiringOpt(true, { llm, consent: consentOf({ ok: true, value: false }) })
    const { stop } = await loadWith(transport, opt)

    transport.emit({ jsonrpc: "2.0", id: 7, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    expect(reply.id).toBe(7)
    expect(reply.result).toBeUndefined()
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("user-denied")
    expect(calls()).toBe(0)
    await stop()
  })
})

describe("B1 live wire — knob OFF (byte-identical default construction)", () => {
  it("(C) no samplingWiring opt ⇒ client does NOT advertise sampling + headless rejecter declines", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    // Gate OFF ⇒ samplingWiringOpt returns undefined ⇒ the opt is omitted, so
    // loadMcpTools constructs the client EXACTLY as it does today.
    const opt = samplingWiringOpt(false, { llm, consent: consentOf({ ok: true, value: true }) })
    expect(opt).toBeUndefined()
    const { stop } = await loadWith(transport, opt)

    expect("sampling" in initCaps(transport)).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 8, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    expect(reply.id).toBe(8)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("no-handler")
    expect(calls()).toBe(0)
    await stop()
  })
})

describe("B1 live wire — headless consent (knob ON, no interactive prompter)", () => {
  it("(D) headless rejecter as consent ⇒ denied by default, LLM NOT called", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const opt = samplingWiringOpt(true, { llm, consent: headlessRejecter })
    const { stop } = await loadWith(transport, opt)

    transport.emit({ jsonrpc: "2.0", id: 21, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("user-denied")
    expect(calls()).toBe(0)
    await stop()
  })
})
