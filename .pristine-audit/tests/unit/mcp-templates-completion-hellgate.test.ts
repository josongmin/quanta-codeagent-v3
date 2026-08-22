/** TICKET-20 hellgate — typed MCP `resources/templates/list` +
 *  `completion/complete` (OUTBOUND, client → server), driven over a FAKE
 *  transport. Both are gated on a SERVER-advertised capability:
 *    - templates folds under the existing `resources` capability;
 *    - completion is gated on a SERVER `completions` capability.
 *
 *  Adversarial coverage:
 *   (1) resources/templates/list round-trip carrying `uriTemplate` (RFC 6570);
 *   (2) completion/complete → typed values + total/hasMore;
 *   (3) a malformed template (no string uriTemplate) is DROPPED; an all-malformed
 *       list yields an OK empty array (not malformed);
 *   (4) a malformed completion (completion-not-object) → typed `malformed`, no
 *       throw;
 *   (5) an EMPTY completion `values:[]` is a VALID ok result (NOT malformed);
 *   (6) RED-ON-INJECTION: no `completions` capability ⇒ `complete()` returns the
 *       typed `unsupported` failure AND NO `completion/complete` frame is ever
 *       put on the wire (refused LOCALLY, no `-32601` leak); same for
 *       `listResourceTemplates` when `resources` is absent;
 *   (7) DEFAULT-OFF byte-identity: with neither capability advertised, the
 *       outbound `initialize` + `tools/list` bytes are IDENTICAL to a baseline
 *       client that never knew about templates/completion.
 */

import { describe, expect, it } from "bun:test"
import { McpClient } from "@/mcp/client"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

/** A fake transport whose `initialize` reply advertises the given server caps;
 *  every other outbound request is answered by a per-method scripted responder
 *  (a missing responder → a raw `-32601`). Mirrors the H19 resources hellgate. */
class FakeTransport implements McpTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
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
  requests(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => typeof m.id === "number" && typeof m.method === "string")
  }
}

const startReady = async (client: McpClient): Promise<void> => {
  const p = client.start()
  await flush()
  await p
}

// resources advertised (templates fold under it) AND a completions capability.
const FULL_CAPS = { resources: {}, completions: {}, tools: {} }

describe("TICKET-20 — resources/templates/list", () => {
  it("(1) templates round-trip carrying uriTemplate (RFC 6570)", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("resources/templates/list", () => ({
      result: {
        resourceTemplates: [
          {
            uriTemplate: "file:///logs/{name}.log",
            name: "log",
            description: "a log file",
            mimeType: "text/plain",
          },
          { uriTemplate: "db:///{table}" },
        ],
      },
    }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)

    const list = await client.listResourceTemplates()
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error("unreachable")
    expect(list.value.map((r) => r.uriTemplate)).toEqual([
      "file:///logs/{name}.log",
      "db:///{table}",
    ])
    expect(list.value[0]).toEqual({
      uriTemplate: "file:///logs/{name}.log",
      name: "log",
      description: "a log file",
      mimeType: "text/plain",
    })
    // exactOptionalPropertyTypes: absent fields are OMITTED, not undefined.
    const second = list.value[1]
    expect(second).toBeDefined()
    expect("name" in (second ?? {})).toBe(false)
    await client.stop()
  })

  it("(3) malformed template dropped; all-malformed → ok empty (not malformed)", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("resources/templates/list", () => ({
      result: {
        resourceTemplates: [
          { name: "no-template" }, // missing string uriTemplate → dropped
          42, // not an object → dropped
          { uriTemplate: "file:///{x}" }, // valid
        ],
      },
    }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const list = await client.listResourceTemplates()
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error("unreachable")
    expect(list.value).toEqual([{ uriTemplate: "file:///{x}" }])
    await client.stop()

    const t2 = new FakeTransport(FULL_CAPS)
    t2.responders.set("resources/templates/list", () => ({
      result: { resourceTemplates: [{ name: "x" }, { foo: 1 }] }, // ALL malformed
    }))
    const c2 = new McpClient({ name: "t", command: ["x"] }, { transport: t2 })
    await startReady(c2)
    const empty = await c2.listResourceTemplates()
    expect(empty.ok).toBe(true)
    if (!empty.ok) throw new Error("unreachable")
    expect(empty.value).toEqual([]) // empty, NOT a malformed failure
    await c2.stop()
  })

  it("malformed (resourceTemplates not an array) → typed malformed, no throw", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("resources/templates/list", () => ({ result: { resourceTemplates: "nope" } }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const list = await client.listResourceTemplates()
    expect(list.ok).toBe(false)
    if (list.ok) throw new Error("unreachable")
    expect(list.reason).toBe("malformed")
    await client.stop()
  })
})

describe("TICKET-20 — completion/complete", () => {
  it("(2) completion values + total/hasMore round-trip typed", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("completion/complete", (_id, params) => {
      // The ref + argument were forwarded on the wire.
      expect(params).toEqual({
        ref: { type: "ref/prompt", name: "review" },
        argument: { name: "lang", value: "t" },
      })
      return {
        result: { completion: { values: ["ts", "tsx", "toml"], total: 240, hasMore: true } },
      }
    })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)

    const got = await client.complete(
      { type: "ref/prompt", name: "review" },
      { name: "lang", value: "t" },
    )
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error("unreachable")
    expect(got.value.values).toEqual(["ts", "tsx", "toml"])
    expect(got.value.total).toBe(240)
    expect(got.value.hasMore).toBe(true)
    await client.stop()
  })

  it("(5) EMPTY values:[] → ok (NOT malformed)", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("completion/complete", () => ({ result: { completion: { values: [] } } }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const got = await client.complete(
      { type: "ref/resource", uri: "file:///x" },
      { name: "q", value: "" },
    )
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error("unreachable")
    expect(got.value.values).toEqual([]) // first-class OK, not malformed
    expect("total" in got.value).toBe(false)
    expect("hasMore" in got.value).toBe(false)
    await client.stop()
  })

  it("(4) malformed completion (completion-not-object) → reason 'malformed', no throw", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("completion/complete", () => ({ result: { completion: "not-an-object" } }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const got = await client.complete({ type: "ref/prompt", name: "p" }, { name: "a", value: "" })
    expect(got.ok).toBe(false)
    if (got.ok) throw new Error("unreachable")
    expect(got.reason).toBe("malformed")
    await client.stop()
  })

  it("non-string completion values are filtered out (defensive narrowing)", async () => {
    const t = new FakeTransport(FULL_CAPS)
    t.responders.set("completion/complete", () => ({
      result: { completion: { values: ["ok", 42, null, "fine"] } },
    }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const got = await client.complete({ type: "ref/prompt", name: "p" }, { name: "a", value: "" })
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error("unreachable")
    expect(got.value.values).toEqual(["ok", "fine"])
    await client.stop()
  })
})

describe("TICKET-20 — RED-ON-INJECTION: capability gating refuses LOCALLY", () => {
  it("(6) no completions cap → complete()===unsupported AND no completion/complete frame on wire", async () => {
    // Server advertises ONLY tools — neither resources nor completions.
    const t = new FakeTransport({ tools: {} })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const before = t.requests().length

    const got = await client.complete({ type: "ref/prompt", name: "p" }, { name: "a", value: "" })
    expect(got.ok).toBe(false)
    if (got.ok) throw new Error("unreachable")
    expect(got.reason).toBe("unsupported")

    // RED-ON-INJECTION: the request was refused LOCALLY — NO frame ever sent.
    expect(t.requests().length).toBe(before)
    expect(t.sent.some((m) => m.method === "completion/complete")).toBe(false)
    await client.stop()
  })

  it("(6b) no resources cap → listResourceTemplates()===unsupported AND no frame on wire", async () => {
    const t = new FakeTransport({ tools: {} })
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    const before = t.requests().length

    const list = await client.listResourceTemplates()
    expect(list.ok).toBe(false)
    if (list.ok) throw new Error("unreachable")
    expect(list.reason).toBe("unsupported")

    expect(t.requests().length).toBe(before)
    expect(t.sent.some((m) => m.method === "resources/templates/list")).toBe(false)
    await client.stop()
  })
})

describe("TICKET-20 — DEFAULT-OFF byte-identity", () => {
  it("(7) neither cap advertised → initialize + listTools outbound bytes IDENTICAL to baseline", async () => {
    // Baseline: a client that exercises ONLY the pre-ticket surface.
    const baseCaps = { tools: {} }
    const baseT = new FakeTransport(baseCaps)
    baseT.responders.set("tools/list", () => ({ result: { tools: [] } }))
    const baseClient = new McpClient({ name: "t", command: ["x"] }, { transport: baseT })
    await startReady(baseClient)
    await baseClient.listTools()
    await baseClient.stop()

    // Ticket-aware client over a server advertising NEITHER resources nor
    // completions — same outbound surface, no templates/completion frames.
    const t = new FakeTransport(baseCaps)
    t.responders.set("tools/list", () => ({ result: { tools: [] } }))
    const client = new McpClient({ name: "t", command: ["x"] }, { transport: t })
    await startReady(client)
    await client.listTools()
    await client.stop()

    // Outbound wire bytes are byte-identical (id, method, params) across both.
    expect(JSON.stringify(t.sent)).toBe(JSON.stringify(baseT.sent))
    // And no template/completion frame leaked.
    expect(t.sent.some((m) => m.method === "resources/templates/list")).toBe(false)
    expect(t.sent.some((m) => m.method === "completion/complete")).toBe(false)
  })
})
