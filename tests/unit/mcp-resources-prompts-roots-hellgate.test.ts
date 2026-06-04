/** H19 (jun-04) hellgate — MCP resources/prompts/roots typed methods.
 *
 *  Codex `rmcp-client` implements the full method set (`resources/list`,
 *  `resources/read`, `resources/subscribe`, `prompts/list`, `prompts/get`,
 *  `roots/list`, `notifications/resources/updated`). quanta's `McpClient`
 *  previously only spoke `tools/*` + inbound elicitation/sampling. This battery
 *  is adversarial against a scripted fake server:
 *
 *   (R1) resources/list → typed McpResource[] (malformed entries dropped);
 *   (R2) resources/read → typed McpResourceContents[] (text + blob);
 *   (R3) resources/subscribe + inbound notifications/resources/updated reaches
 *        the observer; unwired observer is a no-op (no throw);
 *   (P1) prompts/list → typed McpPrompt[];
 *   (P2) prompts/get → typed McpPromptMessage[] (with arguments echoed in params);
 *   (RT1) roots advertised ONLY when a roots provider is wired (advertise-iff-able);
 *   (RT2) inbound roots/list WITH provider → returns the configured roots;
 *   (RT3) inbound roots/list with EMPTY provider → returns [];
 *   (RT4) inbound roots/list with NO provider → still -32601 (unadvertised);
 *   (M1) malformed server responses → typed no-throw empty results;
 *   (G1) elicitation + sampling inbound routing unaffected (regression guard).
 */

import { describe, expect, it } from "bun:test"
import { fullNegotiator } from "@/mcp/capabilities/full-negotiator"
import { McpClient } from "@/mcp/client"
import { MCP_ELICITATION_METHOD } from "@/mcp/elicitation/inbound-router"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import {
  type McpResourceUpdate,
  MCP_RESOURCES_UPDATED_METHOD,
  MCP_ROOTS_LIST_METHOD,
  type Root,
  type RootsProviderPort,
} from "@/mcp/resources"
import { MCP_SAMPLING_METHOD } from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Scripted transport: tests inspect every send and reply to outbound requests
 *  with a programmable responder keyed by method. */
class ScriptedTransport implements McpTransport {
  private messageHandler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  /** Per-method canned `result` payloads for outbound requests. */
  responders: Record<string, unknown> = {}

  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const p = payload as Record<string, unknown>
    this.sent.push(p)
    // Auto-respond to outbound requests (those with an id AND a method) using
    // the canned responder for that method, so listResources()/readResource()
    // etc. resolve. `initialize` is handled by the harness below.
    const method = p["method"] as string | undefined
    const id = p["id"]
    if (method !== undefined && id !== undefined && method !== "initialize") {
      if (Object.hasOwn(this.responders, method)) {
        const result = this.responders[method]
        queueMicrotask(() => this.emit({ jsonrpc: "2.0", id: id as number, result }))
      }
    }
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

const findSend = (t: ScriptedTransport, method: string): Record<string, unknown> | undefined =>
  t.sent.find((m) => m["method"] === method)

const fixedRoots = (roots: Root[]): RootsProviderPort => ({ listRoots: async () => roots })

describe("H19 resources/list + read", () => {
  it("(R1) resources/list → typed McpResource[], malformed entries dropped", async () => {
    const transport = new ScriptedTransport()
    transport.responders["resources/list"] = {
      resources: [
        { uri: "file:///a.txt", name: "a", mimeType: "text/plain" },
        { uri: "file:///b.bin", name: "b" },
        { name: "no-uri" }, // malformed: dropped
        42, // malformed: dropped
      ],
    }
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)

    const resources = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(["file:///a.txt", "file:///b.bin"])
    expect(resources[0]?.name).toBe("a")
    expect(resources[0]?.mimeType).toBe("text/plain")
    // The wire request used the right method.
    expect(findSend(transport, "resources/list")).toBeDefined()
    await client.stop()
  })

  it("(R2) resources/read → typed McpResourceContents[] (text + blob)", async () => {
    const transport = new ScriptedTransport()
    transport.responders["resources/read"] = {
      contents: [
        { uri: "file:///a.txt", mimeType: "text/plain", text: "hello" },
        { uri: "file:///b.bin", mimeType: "application/octet-stream", blob: "QUJD" },
        { text: "missing-uri" }, // malformed: dropped
      ],
    }
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)

    const contents = await client.readResource("file:///a.txt")
    expect(contents.length).toBe(2)
    expect(contents[0]).toEqual({ uri: "file:///a.txt", mimeType: "text/plain", text: "hello" })
    expect(contents[1]?.blob).toBe("QUJD")
    // params carried the uri.
    const sent = findSend(transport, "resources/read")
    expect((sent?.params as { uri: string }).uri).toBe("file:///a.txt")
    await client.stop()
  })

  it("(M1) malformed resources/list result → no throw, empty array", async () => {
    const transport = new ScriptedTransport()
    transport.responders["resources/list"] = { resources: "not-an-array" }
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    expect(await client.listResources()).toEqual([])
    await client.stop()
  })

  it("(M2) read result with no contents → empty array, no throw", async () => {
    const transport = new ScriptedTransport()
    transport.responders["resources/read"] = {}
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    expect(await client.readResource("file:///x")).toEqual([])
    await client.stop()
  })
})

describe("H19 resources/subscribe + notifications/resources/updated", () => {
  it("(R3) subscribe + inbound updated-notification reaches the observer", async () => {
    const transport = new ScriptedTransport()
    transport.responders["resources/subscribe"] = {}
    const updates: McpResourceUpdate[] = []
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, resourceUpdateObserver: { onResourceUpdated: (u) => updates.push(u) } },
    )
    await startReady(client, transport)

    await client.subscribeResource("file:///watch.txt")
    const sent = findSend(transport, "resources/subscribe")
    expect((sent?.params as { uri: string }).uri).toBe("file:///watch.txt")

    // Server pushes an update notification (no id ⇒ notification).
    transport.emit({
      jsonrpc: "2.0",
      method: MCP_RESOURCES_UPDATED_METHOD,
      params: { uri: "file:///watch.txt" },
    })
    await flush()
    expect(updates).toEqual([{ uri: "file:///watch.txt" }])
    await client.stop()
  })

  it("(R3b) inbound updated-notification with NO observer is a no-op (no throw, no reply)", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({
      jsonrpc: "2.0",
      method: MCP_RESOURCES_UPDATED_METHOD,
      params: { uri: "file:///x" },
    })
    await flush()
    // Notifications carry no reply obligation: nothing sent back.
    expect(transport.sent.length).toBe(before)
    await client.stop()
  })

  it("(R3c) malformed updated-notification (no uri) → observer NOT called, no throw", async () => {
    const transport = new ScriptedTransport()
    const updates: McpResourceUpdate[] = []
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, resourceUpdateObserver: { onResourceUpdated: (u) => updates.push(u) } },
    )
    await startReady(client, transport)
    transport.emit({
      jsonrpc: "2.0",
      method: MCP_RESOURCES_UPDATED_METHOD,
      params: { not: "a uri" },
    })
    await flush()
    expect(updates).toEqual([])
    await client.stop()
  })
})

describe("H19 prompts/list + get", () => {
  it("(P1) prompts/list → typed McpPrompt[]", async () => {
    const transport = new ScriptedTransport()
    transport.responders["prompts/list"] = {
      prompts: [
        {
          name: "review",
          description: "Review code",
          arguments: [{ name: "lang", description: "language", required: true }],
        },
        { name: "bare" },
        { description: "no name" }, // malformed: dropped
      ],
    }
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const prompts = await client.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(["review", "bare"])
    expect(prompts[0]?.arguments?.[0]).toEqual({
      name: "lang",
      description: "language",
      required: true,
    })
    await client.stop()
  })

  it("(P2) prompts/get → typed McpPromptMessage[], arguments echoed in params", async () => {
    const transport = new ScriptedTransport()
    transport.responders["prompts/get"] = {
      description: "Review",
      messages: [
        { role: "user", content: { type: "text", text: "review this" } },
        { role: "assistant", content: { type: "text", text: "ok" } },
        { content: { type: "text", text: "no role" } }, // malformed: dropped
      ],
    }
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const result = await client.getPrompt("review", { lang: "ts" })
    expect(result.description).toBe("Review")
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(result.messages[0]?.content).toEqual({ type: "text", text: "review this" })
    const sent = findSend(transport, "prompts/get")
    expect((sent?.params as { name: string; arguments: unknown }).name).toBe("review")
    expect((sent?.params as { arguments: Record<string, string> }).arguments).toEqual({ lang: "ts" })
    await client.stop()
  })

  it("(P3) prompts/get with no args omits the arguments field; malformed result → empty messages", async () => {
    const transport = new ScriptedTransport()
    transport.responders["prompts/get"] = { messages: "nope" }
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const result = await client.getPrompt("bare")
    expect(result.messages).toEqual([])
    const sent = findSend(transport, "prompts/get")
    expect("arguments" in (sent?.params as object)).toBe(false)
    await client.stop()
  })
})

describe("H19 roots capability (advertise-iff-able)", () => {
  it("(RT1) roots advertised ONLY when a roots provider is wired", () => {
    // No provider ⇒ omitted (honest).
    const without = fullNegotiator().compile()
    expect("roots" in without).toBe(false)
    // Provider wired ⇒ advertised, listChanged honestly false.
    const withRoots = fullNegotiator({ roots: true }).compile()
    expect(withRoots.roots).toEqual({ listChanged: false })
    // Canonical sorted-key order preserved (elicitation < roots < tasks < tools).
    expect(JSON.stringify(withRoots)).toBe(
      '{"elicitation":{},"roots":{"listChanged":false},"tasks":{"listChanged":false},"tools":{}}',
    )
  })

  it("(RT2) inbound roots/list WITH provider → returns the configured roots", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient(
      { name: "t", command: ["x"] },
      {
        transport,
        rootsProvider: fixedRoots([
          { uri: "file:///work", name: "workspace" },
          { uri: "file:///tmp" },
        ]),
      },
    )
    await startReady(client, transport)
    const before = transport.sent.length

    transport.emit({ jsonrpc: "2.0", id: 70, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()

    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect(reply.id).toBe(70)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({
      roots: [{ uri: "file:///work", name: "workspace" }, { uri: "file:///tmp" }],
    })
    await client.stop()
  })

  it("(RT3) inbound roots/list with EMPTY provider → returns []", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, rootsProvider: fixedRoots([]) },
    )
    await startReady(client, transport)
    transport.emit({ jsonrpc: "2.0", id: 71, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.id).toBe(71)
    expect(reply.result).toEqual({ roots: [] })
    await client.stop()
  })

  it("(RT4) inbound roots/list with NO provider wired → still -32601 (unadvertised)", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    transport.emit({ jsonrpc: "2.0", id: 72, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.id).toBe(72)
    expect((reply.error as { code: number }).code).toBe(-32601)
    await client.stop()
  })

  it("(RT5) a roots provider that THROWS → typed error, never drops the request", async () => {
    const transport = new ScriptedTransport()
    const throwing: RootsProviderPort = {
      listRoots: async () => {
        throw new Error("boom")
      },
    }
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport, rootsProvider: throwing },
    )
    await startReady(client, transport)
    const before = transport.sent.length
    transport.emit({ jsonrpc: "2.0", id: 73, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    expect(transport.sent.length).toBe(before + 1)
    const reply = lastSend(transport)
    expect((reply.error as { code: number }).code).toBe(-32000)
    await client.stop()
  })
})

describe("H19 regression guards (elicitation + sampling unaffected)", () => {
  it("(G1) elicitation still declines by default (byte-identical)", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    const before = transport.sent.length
    transport.emit({
      jsonrpc: "2.0",
      id: 99,
      method: MCP_ELICITATION_METHOD,
      params: { message: "?", requestedSchema: { properties: {} } },
    })
    await flush()
    expect(transport.sent.length).toBe(before + 1)
    expect(lastSend(transport).result).toEqual({ action: "decline" })
    await client.stop()
  })

  it("(G2) sampling still declines by default (typed -32000, not -32601)", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    transport.emit({
      jsonrpc: "2.0",
      id: 100,
      method: MCP_SAMPLING_METHOD,
      params: { messages: [{ role: "user", content: { type: "text", text: "x" } }] },
    })
    await flush()
    const reply = lastSend(transport)
    expect((reply.error as { code: number }).code).toBe(-32000)
    await client.stop()
  })

  it("(G3) a genuinely-unknown inbound method still gets -32601", async () => {
    const transport = new ScriptedTransport()
    const client = new McpClient({ name: "t", command: ["x"] }, { transport })
    await startReady(client, transport)
    transport.emit({ jsonrpc: "2.0", id: 5, method: "totally/unknown", params: {} })
    await flush()
    expect((lastSend(transport).error as { code: number }).code).toBe(-32601)
    await client.stop()
  })
})
