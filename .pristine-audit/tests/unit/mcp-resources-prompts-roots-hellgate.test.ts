/** H19 (jun-3-misc §3) hellgate — typed MCP `resources/*` + `prompts/*` +
 *  inbound `roots/list` + change notifications, driven over a FAKE transport.
 *
 *  Adversarial coverage:
 *   (A) resources/list + read round-trip, BOTH text and blob content blocks;
 *   (B) prompts/list + prompts/get → typed messages;
 *   (C) inbound roots/list returns the CONFIGURED roots (sanitized);
 *   (D) resource subscribe + a `notifications/resources/updated` reaches the
 *       wired observer; prompts list_changed reaches it too;
 *   (E) calling a method the server did NOT advertise → typed `unsupported`
 *       failure (NO raw throw, NO `-32601` round-trip emitted);
 *   (F) malformed server response → typed `malformed` failure (no throw);
 *   (G) roots is advertised on the negotiator ONLY when a roots source is wired
 *       (advertise-iff-able honesty); subscribe refused when server omits
 *       `resources.subscribe`.
 */

import { describe, expect, it } from "bun:test"
import { fullNegotiator } from "@/mcp/capabilities"
import { McpClient } from "@/mcp/client"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpResourceNotification, McpRoot } from "@/mcp/resources"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

/** A fake transport whose `initialize` reply advertises the given server caps;
 *  every other outbound request is answered by a per-method scripted responder. */
class FakeTransport implements McpTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  /** method → produce a `result` or `error` for a given (id, params). */
  responders = new Map<
    string,
    (id: number, params: unknown) => { result?: unknown; error?: { code: number; message: string } }
  >()

  constructor(private readonly serverCaps: Record<string, unknown>) {}

  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const msg = payload as Record<string, unknown>
    this.sent.push(msg)
    // Auto-answer outbound REQUESTS (those with an id + method).
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      const id = msg.id
      const method = msg.method
      queueMicrotask(() => {
        if (method === "initialize") {
          this.emit({ jsonrpc: "2.0", id, result: { capabilities: this.serverCaps } })
          return
        }
        const responder = this.responders.get(method)
        if (responder === undefined) {
          this.emit({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          })
          return
        }
        const out = responder(id, msg.params)
        this.emit({ jsonrpc: "2.0", id, ...out })
      })
    }
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.handler?.(msg)
  }
  /** Outbound JSON-RPC requests (id + method), excluding notifications. */
  requests(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => typeof m.id === "number" && typeof m.method === "string")
  }
}

const startReady = async (client: McpClient): Promise<void> => {
  const p = client.start()
  await flush()
  await p
}

const RESOURCE_CAPS = { resources: { subscribe: true }, prompts: {}, tools: {} }

describe("H19 — resources round-trip", () => {
  it("(A) resources/list then resources/read (text + blob) round-trip typed", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    t.responders.set("resources/list", () => ({
      result: {
        resources: [
          { uri: "file:///a.txt", name: "A", mimeType: "text/plain", description: "the a" },
          { uri: "file:///b.bin", mimeType: "application/octet-stream" },
        ],
      },
    }))
    t.responders.set("resources/read", (_id, params) => {
      const uri = (params as { uri: string }).uri
      return {
        result: {
          contents: [
            { uri, mimeType: "text/plain", text: "hello" },
            { uri, mimeType: "application/octet-stream", blob: "AAAA" },
          ],
        },
      }
    })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)

    const list = await client.listResources()
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error("unreachable")
    expect(list.value.map((r) => r.uri)).toEqual(["file:///a.txt", "file:///b.bin"])
    expect(list.value[0]).toEqual({
      uri: "file:///a.txt",
      name: "A",
      mimeType: "text/plain",
      description: "the a",
    })
    // exactOptionalPropertyTypes: absent fields are OMITTED, not undefined.
    const second = list.value[1]
    expect(second).toBeDefined()
    expect("name" in (second ?? {})).toBe(false)

    const read = await client.readResource("file:///a.txt")
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error("unreachable")
    expect(read.value).toHaveLength(2)
    expect(read.value[0]).toEqual({ uri: "file:///a.txt", mimeType: "text/plain", text: "hello" })
    expect(read.value[1]).toEqual({
      uri: "file:///a.txt",
      mimeType: "application/octet-stream",
      blob: "AAAA",
    })
    await client.stop()
  })
})

describe("H19 — prompts round-trip", () => {
  it("(B) prompts/list then prompts/get → typed messages", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    t.responders.set("prompts/list", () => ({
      result: {
        prompts: [
          {
            name: "review",
            description: "review code",
            arguments: [{ name: "lang", required: true }],
          },
        ],
      },
    }))
    t.responders.set("prompts/get", (_id, params) => {
      const p = params as { name: string; arguments?: Record<string, unknown> }
      return {
        result: {
          description: `prompt:${p.name}`,
          messages: [
            { role: "user", content: { type: "text", text: `lang=${p.arguments?.lang}` } },
            { role: "assistant", content: { type: "text", text: "ok" } },
          ],
        },
      }
    })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)

    const list = await client.listPrompts()
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error("unreachable")
    expect(list.value[0]?.name).toBe("review")
    expect(list.value[0]?.arguments?.[0]).toEqual({ name: "lang", required: true })

    const got = await client.getPrompt("review", { lang: "ts" })
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error("unreachable")
    expect(got.value.description).toBe("prompt:review")
    expect(got.value.messages).toHaveLength(2)
    expect(got.value.messages[0]).toEqual({
      role: "user",
      content: { type: "text", text: "lang=ts" },
    })
    // the args were forwarded on the wire
    const getReq = t.requests().find((r) => r.method === "prompts/get")
    expect(getReq?.params).toEqual({ name: "review", arguments: { lang: "ts" } })
    await client.stop()
  })
})

describe("H19 — inbound roots/list", () => {
  it("(C) returns the configured roots (sanitized), advertises roots iff wired", async () => {
    const roots: McpRoot[] = [
      { uri: "file:///work", name: "work" },
      { uri: "file:///lib" },
      { uri: "", name: "dropme" } as McpRoot, // empty uri → dropped
    ]
    const t = new FakeTransport(RESOURCE_CAPS)
    const client = new McpClient(
      { name: "t", command: ["x"] },
      {
        transport: t,
        // advertise-iff-able: a roots source AND a negotiator that emits roots.
        negotiator: fullNegotiator({ roots: true }),
        rootsProvider: { listRoots: () => roots },
      },
    )
    await startReady(client)

    // (G-part) the init advertised `roots` because a provider is wired.
    const init = t.sent[0] as { params: { capabilities: Record<string, unknown> } }
    expect(init.params.capabilities.roots).toBeDefined()

    // Server asks us for roots; we answer from the provider, sanitized.
    const before = t.sent.length
    t.emit({ jsonrpc: "2.0", id: 99, method: "roots/list", params: {} })
    await flush()
    expect(t.sent.length).toBe(before + 1)
    const reply = t.sent[t.sent.length - 1] as {
      id: number
      result: { roots: Array<{ uri: string; name?: string }> }
    }
    expect(reply.id).toBe(99)
    expect(reply.result.roots).toEqual([
      { uri: "file:///work", name: "work" },
      { uri: "file:///lib" },
    ])
    await client.stop()
  })

  it("(G) roots NOT advertised when no provider wired (byte-identical honesty)", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    // negotiator could emit roots, but no provider ⇒ host must not pass roots:true.
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport: t, negotiator: fullNegotiator() },
    )
    await startReady(client)
    const init = t.sent[0] as { params: { capabilities: Record<string, unknown> } }
    expect("roots" in init.params.capabilities).toBe(false)

    // And an unsolicited roots/list with no provider gets an empty list, not a drop.
    t.emit({ jsonrpc: "2.0", id: 5, method: "roots/list", params: {} })
    await flush()
    const reply = t.sent[t.sent.length - 1] as { id: number; result: { roots: unknown[] } }
    expect(reply.id).toBe(5)
    expect(reply.result.roots).toEqual([])
    await client.stop()
  })
})

describe("H19 — subscriptions + notifications", () => {
  it("(D) subscribe then notifications/resources/updated reaches the observer", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    t.responders.set("resources/subscribe", () => ({ result: {} }))
    t.responders.set("resources/unsubscribe", () => ({ result: {} }))
    const seen: McpResourceNotification[] = []
    const client = new McpClient(
      { name: "t", command: ["x"] },
      { transport: t, resourceObserver: { onNotification: (e) => seen.push(e) } },
    )
    await startReady(client)

    const sub = await client.subscribeResource("file:///a.txt")
    expect(sub.ok).toBe(true)
    const subReq = t.requests().find((r) => r.method === "resources/subscribe")
    expect(subReq?.params).toEqual({ uri: "file:///a.txt" })

    // server pushes an update notification (no id ⇒ no reply obligation)
    t.emit({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "file:///a.txt" },
    })
    t.emit({ jsonrpc: "2.0", method: "notifications/resources/list_changed" })
    t.emit({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" })
    await flush()

    expect(seen).toEqual([
      { kind: "resource_updated", uri: "file:///a.txt" },
      { kind: "resource_list_changed" },
      { kind: "prompt_list_changed" },
    ])

    const unsub = await client.unsubscribeResource("file:///a.txt")
    expect(unsub.ok).toBe(true)
    await client.stop()
  })

  it("absent observer ignores notifications gracefully (no throw)", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    expect(() => {
      t.emit({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "x" },
      })
    }).not.toThrow()
    await client.stop()
  })
})

describe("H19 — capability gating (no raw -32601 surprise)", () => {
  it("(E) method whose capability the server didn't advertise → typed unsupported, no request emitted", async () => {
    // Server advertises ONLY tools — not resources/prompts.
    const t = new FakeTransport({ tools: {} })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const before = t.requests().length

    const list = await client.listResources()
    expect(list.ok).toBe(false)
    if (list.ok) throw new Error("unreachable")
    expect(list.reason).toBe("unsupported")

    const prompts = await client.listPrompts()
    expect(prompts.ok).toBe(false)
    if (prompts.ok) throw new Error("unreachable")
    expect(prompts.reason).toBe("unsupported")

    // No outbound request was ever put on the wire (we refused locally).
    expect(t.requests().length).toBe(before)
    await client.stop()
  })

  it("(G2) subscribe refused when server omits resources.subscribe", async () => {
    // resources present but subscribe NOT supported.
    const t = new FakeTransport({ resources: {}, tools: {} })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const before = t.requests().length

    const sub = await client.subscribeResource("file:///a.txt")
    expect(sub.ok).toBe(false)
    if (sub.ok) throw new Error("unreachable")
    expect(sub.reason).toBe("unsupported")
    // listResources still works (resources advertised), subscribe alone refused.
    expect(t.requests().length).toBe(before)
    await client.stop()
  })
})

describe("H19 — malformed server response", () => {
  it("(F) resources/read returns a non-array contents → typed malformed, no throw", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    t.responders.set("resources/read", () => ({ result: { contents: "not-an-array" } }))
    t.responders.set("resources/list", () => ({ result: { nope: 1 } }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)

    const read = await client.readResource("file:///x")
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error("unreachable")
    expect(read.reason).toBe("malformed")

    const list = await client.listResources()
    expect(list.ok).toBe(false)
    if (list.ok) throw new Error("unreachable")
    expect(list.reason).toBe("malformed")
    await client.stop()
  })

  it("transport error (server JSON-RPC error) → typed transport failure", async () => {
    const t = new FakeTransport(RESOURCE_CAPS)
    t.responders.set("resources/list", (id) => ({
      // simulate a server-side error response
      error: { code: -32000, message: `boom ${id}` },
    }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const list = await client.listResources()
    expect(list.ok).toBe(false)
    if (list.ok) throw new Error("unreachable")
    expect(list.reason).toBe("transport")
    await client.stop()
  })
})
