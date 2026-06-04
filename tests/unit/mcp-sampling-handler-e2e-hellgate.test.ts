/** ADR-0470 B1 follow-up e2e hellgate — composition root → McpClient → handler.
 *
 *  Proves the whole wired path end-to-end, NOT just the handler in isolation:
 *   (A) knob ON + fake LLM + consent(allow) → inbound `sampling/createMessage`
 *       routes THROUGH the real `@/llm`-backed handler → LLM called → a
 *       `CreateMessageResult` is sent back as the JSON-RPC `result`;
 *   (B) consent(deny) → JSON-RPC error carrying `user-denied`, LLM NOT called;
 *   (C) knob OFF → sampling NOT advertised AND the headless rejecter declines
 *       (`no-handler`) → byte-identical to today;
 *   (D) LLM error (after consent) → JSON-RPC error carrying `error`, no crash;
 *   (E) headless (no consent prompter) → denied by default, LLM NOT called;
 *   (F) advertise-iff-handler at the wire: pickMcpNegotiator + buildSamplingWiring
 *       move together (ON advertises sampling, OFF omits it).
 */

import { describe, expect, it } from "bun:test"
import { buildSamplingWiring, pickMcpNegotiator } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ElicitationPrompter, ElicitationResult } from "@/mcp"
import { McpClient } from "@/mcp/client"
import { headlessRejecter } from "@/mcp/elicitation/headless-rejecter"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { MCP_SAMPLING_METHOD } from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"

/** Drain enqueued microtasks until the inbound route + async handler (consent
 *  promise + LLM stream drain + reply send) has fully settled. The real handler
 *  awaits several microtasks (prompter → generator iteration → assemble), so we
 *  flush generously — more turns than any path needs. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 64; i++) await Promise.resolve()
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

const startReady = async (client: McpClient, transport: ScriptedTransport): Promise<void> => {
  const startP = client.start()
  await flush()
  const init = transport.sent[0] as { id: number }
  transport.emit({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "x" } })
  await startP
}

const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

const fakeLlm = (
  events: StreamEvent[] = [
    { type: "text_delta", delta: "4" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
): { llm: LLMPort; calls: () => number } => {
  let n = 0
  return {
    calls: () => n,
    llm: {
      model: "fake-model",
      stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        n += 1
        return (async function* () {
          for (const ev of events) yield ev
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
const sampleParams = {
  messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
  systemPrompt: "You are a calculator.",
  maxTokens: 16,
}

/** Build a client exactly as the composition root would: ONE gate
 *  ({@link buildSamplingWiring}) yields BOTH the advertisement flag (fed to
 *  {@link pickMcpNegotiator}) and the handler (fed to the McpClient). */
const wiredClient = (
  transport: ScriptedTransport,
  knobOn: boolean,
  deps: { llm: LLMPort; consent: ElicitationPrompter } | undefined,
): McpClient => {
  const wiring = buildSamplingWiring(knobOn, deps)
  const negotiator = pickMcpNegotiator(ON, { sampling: wiring.advertise })
  return new McpClient(
    { name: "t", command: ["x"] },
    {
      transport,
      negotiator,
      ...(wiring.handler !== undefined ? { samplingHandler: wiring.handler } : {}),
    },
  )
}

describe("ADR-0470 e2e — knob ON, consent allow", () => {
  it("(A) inbound sampling/createMessage routes through the real handler → LLM called → result", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const client = wiredClient(transport, true, {
      llm,
      consent: consentOf({ ok: true, value: true }),
    })

    await startReady(client, transport)
    // The advertised capabilities include sampling (advertise-iff-handler).
    const initSend = transport.sent[0] as { params: { capabilities: Record<string, unknown> } }
    expect(initSend.params.capabilities.sampling).toEqual({})

    const before = transport.sent.length
    transport.emit({ jsonrpc: "2.0", id: 42, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    expect(calls()).toBe(1) // the real LLM was invoked
    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(42)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({
      role: "assistant",
      content: { type: "text", text: "4" },
      model: "fake-model",
      stopReason: "end_turn",
    })
    await client.stop()
  })
})

describe("ADR-0470 e2e — knob ON, consent deny", () => {
  it("(B) deny ⇒ JSON-RPC error (user-denied) AND the LLM is NEVER called", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const client = wiredClient(transport, true, {
      llm,
      consent: consentOf({ ok: true, value: false }),
    })
    await startReady(client, transport)

    transport.emit({ jsonrpc: "2.0", id: 7, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    expect(reply.id).toBe(7)
    expect(reply.result).toBeUndefined()
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("user-denied")
    expect(calls()).toBe(0)
    await client.stop()
  })
})

describe("ADR-0470 e2e — knob OFF (byte-identical default)", () => {
  it("(C) sampling NOT advertised + headless rejecter declines (no-handler)", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    // knob OFF ⇒ wiring yields no advertisement + no handler.
    const client = wiredClient(transport, false, {
      llm,
      consent: consentOf({ ok: true, value: true }),
    })
    await startReady(client, transport)

    const initSend = transport.sent[0] as { params: { capabilities: Record<string, unknown> } }
    expect("sampling" in initSend.params.capabilities).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 8, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    expect(reply.id).toBe(8)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("no-handler")
    expect(calls()).toBe(0) // never reached an LLM
    await client.stop()
  })
})

describe("ADR-0470 e2e — LLM error after consent", () => {
  it("(D) consent allow + LLM stream throws ⇒ JSON-RPC error (error), no crash", async () => {
    const transport = new ScriptedTransport()
    async function* throwingGen(): AsyncGenerator<StreamEvent> {
      // Reachable `yield` over an empty source ⇒ nothing emitted, then throw.
      for (const ev of [] as StreamEvent[]) yield ev
      throw new Error("provider down")
    }
    const throwingLlm: LLMPort = {
      model: "boom",
      stream: () => throwingGen(),
    }
    const client = wiredClient(transport, true, {
      llm: throwingLlm,
      consent: consentOf({ ok: true, value: true }),
    })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 13, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("error")
    await client.stop()
  })
})

describe("ADR-0470 e2e — headless (no consent prompter)", () => {
  it("(E) handler with the headless rejecter ⇒ denied by default, LLM NOT called", async () => {
    const transport = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    // A deployment with the knob ON but no interactive prompter wired falls back
    // to the headless rejecter — which declines, so no inference is spent.
    const client = wiredClient(transport, true, { llm, consent: headlessRejecter })
    await startReady(client, transport)

    transport.emit({ jsonrpc: "2.0", id: 21, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("user-denied")
    expect(calls()).toBe(0)
    await client.stop()
  })
})

describe("ADR-0470 e2e — advertise-iff-handler at the wire", () => {
  it("(F) ON advertises sampling; OFF omits it (pickMcpNegotiator follows the gate)", () => {
    const llm = fakeLlm().llm
    const consent = consentOf({ ok: true, value: true })

    const onWiring = buildSamplingWiring(true, { llm, consent })
    const onCaps = pickMcpNegotiator(ON, { sampling: onWiring.advertise }).compile()
    expect(onCaps.sampling).toEqual({})
    expect(onWiring.handler).toBeDefined()

    const offWiring = buildSamplingWiring(false, { llm, consent })
    const offCaps = pickMcpNegotiator(ON, { sampling: offWiring.advertise }).compile()
    expect("sampling" in offCaps).toBe(false)
    expect(offWiring.handler).toBeUndefined()

    // And with QUANTA_MCP_CAPS unset, sampling is impossible regardless.
    const defaultCaps = pickMcpNegotiator({} as NodeJS.ProcessEnv, { sampling: true }).compile()
    expect("sampling" in defaultCaps).toBe(false)
  })
})
