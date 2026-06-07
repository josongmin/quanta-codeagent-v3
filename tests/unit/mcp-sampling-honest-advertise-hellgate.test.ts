/** ADR-0470 (jun-04) hellgate — MCP sampling honest advertisement + inbound wiring.
 *
 *  Seals the advertise-iff-able fix for VERIFIED bug B1: quanta used to
 *  advertise `sampling: {}` while `handleInboundRequest` killed any inbound
 *  `sampling/createMessage` with `-32601 method not found` — false advertising
 *  + broken interop.
 *
 *  Adversarial coverage:
 *   (a) no handler wired → negotiated capabilities OMIT `sampling`;
 *   (b) handler wired (`fullNegotiator({sampling:true})`) → `sampling` advertised;
 *   (c) inbound `sampling/createMessage` WITH handler → routes to the port (fake
 *       port asserted called), the completion is sent as the JSON-RPC `result`;
 *   (d) inbound `sampling/createMessage` with NO handler → declines GRACEFULLY
 *       (typed JSON-RPC error, NOT -32601, NOT a crash, NOT a dropped request);
 *   (e) elicitation still works byte-identically (regression guard);
 *   (f) a genuinely-unknown inbound method still gets -32601.
 */

import { describe, expect, it } from "bun:test"
import { fullNegotiator } from "@/mcp/capabilities/full-negotiator"
import { McpClient } from "@/mcp/client"
import { MCP_ELICITATION_METHOD } from "@/mcp/elicitation/inbound-router"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import {
  type CreateMessageRequest,
  MCP_SAMPLING_METHOD,
  type SamplingHandlerPort,
  type SamplingOutcome,
} from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"

/** Drain enqueued microtasks so an inbound request's async route + reply has
 *  fully settled before we assert on what was sent. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Scripted transport: tests push inbound messages and inspect every send.
 *  Mirrors the elicitation hellgate's harness. */
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
  transport.emit({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-06-18" } })
  await startP
}

const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

/** A fake sampling handler recording the request it was given. */
const spyHandler = (
  outcome: SamplingOutcome,
): {
  handler: SamplingHandlerPort
  calls: () => number
  lastReq: () => CreateMessageRequest | null
} => {
  let n = 0
  let last: CreateMessageRequest | null = null
  return {
    calls: () => n,
    lastReq: () => last,
    handler: {
      createMessage: async (req) => {
        n += 1
        last = req
        return outcome
      },
    },
  }
}

const sampleParams = {
  messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
  systemPrompt: "You are a calculator.",
  maxTokens: 16,
}

describe("ADR-0470 honest advertisement (advertise-iff-able)", () => {
  it("(a) no sampling handler wired → negotiated capabilities OMIT sampling", () => {
    const caps = fullNegotiator().compile()
    expect(caps.sampling).toBeUndefined()
    expect("sampling" in caps).toBe(false)
    // The fulfillable flags remain advertised.
    expect(caps.tools).toEqual({})
    expect(caps.elicitation).toEqual({})
    expect(caps.tasks).toEqual({ listChanged: false })
    // Honest on the wire: serialization omits sampling.
    expect(JSON.stringify(caps)).toBe('{"elicitation":{},"tasks":{"listChanged":false},"tools":{}}')
  })

  it("(b) sampling handler wired → sampling IS advertised", () => {
    const caps = fullNegotiator({ sampling: true }).compile()
    expect(caps.sampling).toEqual({})
    // Canonical sorted-key order preserved.
    expect(JSON.stringify(caps)).toBe(
      '{"elicitation":{},"sampling":{},"tasks":{"listChanged":false},"tools":{}}',
    )
  })
})

describe("ADR-0470 inbound sampling/createMessage routing", () => {
  it("(c) WITH handler → routes to the port, completion sent as JSON-RPC result", async () => {
    const transport = new ScriptedTransport()
    const { handler, calls, lastReq } = spyHandler({
      ok: true,
      result: {
        role: "assistant",
        content: { type: "text", text: "4" },
        model: "fake-model",
        stopReason: "endTurn",
      },
    })
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, samplingHandler: handler },
    )
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 42, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    // The port was invoked exactly once with the parsed request.
    expect(calls()).toBe(1)
    const req = lastReq()
    expect(req?.messages).toEqual([{ role: "user", content: { type: "text", text: "2+2?" } }])
    expect(req?.systemPrompt).toBe("You are a calculator.")
    expect(req?.maxTokens).toBe(16)

    // A single reply carrying the completion as `result` (not error, not drop).
    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(42)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({
      role: "assistant",
      content: { type: "text", text: "4" },
      model: "fake-model",
      stopReason: "endTurn",
    })
    await client.stop()
  })

  it("(d) NO handler wired → declines gracefully (typed error, NOT -32601, NOT a crash)", async () => {
    const transport = new ScriptedTransport()
    // No samplingHandler ⇒ default headlessSamplingRejecter.
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 7, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    // Replied (not dropped) with a typed decline — and crucially NOT -32601
    // (which is what the false-advertising bug produced). The method IS
    // recognized; the client simply declined.
    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(7)
    expect(reply.result).toBeUndefined()
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.code).not.toBe(-32601)
    expect(err.message).toContain("no-handler")
    await client.stop()
  })

  it("(d2) malformed createMessage params (empty messages) → graceful decline, handler NOT called", async () => {
    const transport = new ScriptedTransport()
    const { handler, calls } = spyHandler({
      ok: true,
      result: { role: "assistant", content: "x", model: "m" },
    })
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, samplingHandler: handler },
    )
    await startReady(client, transport)

    transport.emit({ jsonrpc: "2.0", id: 9, method: MCP_SAMPLING_METHOD, params: { messages: [] } })
    await flush()

    const reply = lastSend(transport)
    expect(reply.id).toBe(9)
    expect((reply.error as { code: number }).code).toBe(-32000)
    expect(calls()).toBe(0) // never reached the handler
    await client.stop()
  })

  it("(c2) handler that declines (user-denied) → typed error carrying the reason", async () => {
    const transport = new ScriptedTransport()
    const { handler } = spyHandler({ ok: false, reason: "user-denied" })
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, samplingHandler: handler },
    )
    await startReady(client, transport)

    transport.emit({ jsonrpc: "2.0", id: 11, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    const reply = lastSend(transport)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("user-denied")
    await client.stop()
  })

  it("(c3) a handler that THROWS is mapped to a typed decline, never drops/crashes", async () => {
    const transport = new ScriptedTransport()
    const throwing: SamplingHandlerPort = {
      createMessage: async () => {
        throw new Error("boom")
      },
    }
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, samplingHandler: throwing },
    )
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 13, method: MCP_SAMPLING_METHOD, params: sampleParams })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect((reply.error as { code: number }).code).toBe(-32000)
    await client.stop()
  })
})

describe("ADR-0470 regression guards (elicitation + unknown methods)", () => {
  it("(e) elicitation still works byte-identically (default headless → decline)", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({
      jsonrpc: "2.0",
      id: 99,
      method: MCP_ELICITATION_METHOD,
      params: {
        message: "Your name?",
        requestedSchema: { properties: { name: { type: "string" } } },
      },
    })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(99)
    // Byte-identical to the pre-ADR-0470 elicitation behavior.
    expect(reply.result).toEqual({ action: "decline" })
    expect(reply.error).toBeUndefined()
    await client.stop()
  })

  it("(f) a genuinely-unknown inbound method still gets -32601", async () => {
    // NB: `roots/list` is now a RECOGNIZED inbound method (H19) — it answers
    // from the roots provider, not -32601. Use a method no handler recognizes.
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 5, method: "totally/unknown", params: {} })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(5)
    expect((reply.error as { code: number }).code).toBe(-32601)
    await client.stop()
  })
})
