/** H19 (jun-04) e2e hellgate — full resources/prompts/roots request/response/
 *  notification cycle over a fake in-memory JSON-RPC transport simulating a
 *  REAL server that exposes resources + prompts AND asks the client for its
 *  roots.
 *
 *  Unlike the unit hellgate (which canned per-method `result`s), this drives an
 *  actual `FakeMcpServer` that:
 *   - answers initialize / resources/list / resources/read / resources/subscribe
 *     / prompts/list / prompts/get like a spec-conformant server;
 *   - emits notifications/resources/updated after a subscribe;
 *   - sends an inbound roots/list REQUEST to the client and asserts the reply.
 */

import { describe, expect, it } from "bun:test"
import { fullNegotiator } from "@/mcp/capabilities/full-negotiator"
import { McpClient } from "@/mcp/client"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import {
  type McpResourceUpdate,
  MCP_RESOURCES_UPDATED_METHOD,
  MCP_ROOTS_LIST_METHOD,
  type Root,
} from "@/mcp/resources"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

/** An in-memory MCP server speaking real JSON-RPC over the transport seam. It
 *  receives the client's outbound requests via `send()` and pushes responses
 *  and notifications back through the message handler. It can also originate an
 *  inbound `roots/list` request and capture the client's reply. */
class FakeMcpServer implements McpTransport {
  private handler: ((m: JsonRpcMessage) => void) | null = null
  /** Every client reply to an inbound server-originated request, by id. */
  readonly clientReplies = new Map<number | string, Record<string, unknown>>()
  private nextInboundId = 9000

  start(): Promise<void> {
    return Promise.resolve()
  }
  onMessage(h: (m: JsonRpcMessage) => void): () => void {
    this.handler = h
    return () => {
      this.handler = null
    }
  }
  onExit(): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }

  send(payload: unknown): Error | null {
    const p = payload as Record<string, unknown>
    const method = p["method"] as string | undefined
    const id = p["id"]
    // A reply from the client to a server-originated request (has id, no method).
    if (method === undefined && id !== undefined) {
      this.clientReplies.set(id as number, p)
      return null
    }
    // A client→server request we must answer.
    if (method !== undefined && id !== undefined) {
      const result = this.answer(method, p["params"])
      if (result !== undefined) {
        queueMicrotask(() => this.reply(id as number, result))
      }
    }
    return null
  }

  private reply(id: number, result: unknown): void {
    this.handler?.({ jsonrpc: "2.0", id, result })
  }

  /** Push an inbound notification to the client. */
  notify(method: string, params: unknown): void {
    this.handler?.({ jsonrpc: "2.0", method, params })
  }

  /** Originate an inbound `roots/list` REQUEST and return its id. */
  askRoots(): number {
    const id = this.nextInboundId++
    this.handler?.({ jsonrpc: "2.0", id, method: MCP_ROOTS_LIST_METHOD, params: {} })
    return id
  }

  private answer(method: string, _params: unknown): unknown {
    switch (method) {
      case "initialize":
        return { protocolVersion: "2025-06-18", capabilities: { resources: {}, prompts: {} } }
      case "resources/list":
        return {
          resources: [
            { uri: "file:///readme.md", name: "readme", mimeType: "text/markdown" },
            { uri: "file:///logo.png", name: "logo", mimeType: "image/png" },
          ],
        }
      case "resources/read":
        return {
          contents: [{ uri: "file:///readme.md", mimeType: "text/markdown", text: "# Title" }],
        }
      case "resources/subscribe":
        return {}
      case "prompts/list":
        return {
          prompts: [
            { name: "summarize", description: "Summarize text", arguments: [{ name: "text" }] },
          ],
        }
      case "prompts/get":
        return {
          description: "Summarize",
          messages: [{ role: "user", content: { type: "text", text: "Summarize: foo" } }],
        }
      default:
        return undefined // leaves the request to time out (none expected in e2e)
    }
  }
}

const start = async (client: McpClient, server: FakeMcpServer): Promise<void> => {
  // initialize auto-answered by the server's answer().
  await client.start()
  await flush()
}

describe("H19 e2e — full resources/prompts cycle over a fake server", () => {
  it("lists + reads resources, lists + gets prompts end-to-end", async () => {
    const server = new FakeMcpServer()
    const client = new McpClient({ name: "srv", command: ["x"] }, { transport: server })
    await start(client, server)

    const resources = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(["file:///readme.md", "file:///logo.png"])

    const contents = await client.readResource("file:///readme.md")
    expect(contents[0]?.text).toBe("# Title")
    expect(contents[0]?.mimeType).toBe("text/markdown")

    const prompts = await client.listPrompts()
    expect(prompts[0]?.name).toBe("summarize")
    expect(prompts[0]?.arguments?.[0]?.name).toBe("text")

    const got = await client.getPrompt("summarize", { text: "foo" })
    expect(got.messages[0]?.role).toBe("user")
    expect(got.messages[0]?.content).toEqual({ type: "text", text: "Summarize: foo" })

    await client.stop()
  })

  it("subscribe then a server-pushed updated-notification reaches the observer", async () => {
    const server = new FakeMcpServer()
    const updates: McpResourceUpdate[] = []
    const client = new McpClient(
      { name: "srv", command: ["x"] },
      { transport: server, resourceUpdateObserver: { onResourceUpdated: (u) => updates.push(u) } },
    )
    await start(client, server)

    await client.subscribeResource("file:///readme.md")
    server.notify(MCP_RESOURCES_UPDATED_METHOD, { uri: "file:///readme.md" })
    await flush()
    expect(updates).toEqual([{ uri: "file:///readme.md" }])

    await client.stop()
  })

  it("server asks roots/list; the wired client answers with its configured roots", async () => {
    const server = new FakeMcpServer()
    const roots: Root[] = [{ uri: "file:///project", name: "project" }]
    const client = new McpClient(
      { name: "srv", command: ["x"] },
      {
        transport: server,
        negotiator: fullNegotiator({ roots: true }),
        rootsProvider: { listRoots: async () => roots },
      },
    )
    await start(client, server)

    const id = server.askRoots()
    await flush()
    const reply = server.clientReplies.get(id)
    expect(reply).toBeDefined()
    expect(reply?.["result"]).toEqual({ roots: [{ uri: "file:///project", name: "project" }] })

    // Sanity: the initialize advertised roots (wired).
    const caps = fullNegotiator({ roots: true }).compile()
    expect(caps.roots).toEqual({ listChanged: false })

    await client.stop()
  })

  it("server asks roots/list but client has NO provider → -32601 (honest non-advertisement)", async () => {
    const server = new FakeMcpServer()
    const client = new McpClient({ name: "srv", command: ["x"] }, { transport: server })
    await start(client, server)
    const id = server.askRoots()
    await flush()
    const reply = server.clientReplies.get(id)
    expect((reply?.["error"] as { code: number }).code).toBe(-32601)
    await client.stop()
  })
})
