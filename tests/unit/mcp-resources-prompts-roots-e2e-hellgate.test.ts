/** H19 e2e hellgate — a fuller FAKE MCP server (a real stateful handler that
 *  advertises `resources` + `prompts` on `initialize`) driven end-to-end
 *  through the real {@link McpClient}.
 *
 *  Unlike the unit hellgate (per-method scripted responders), this exercises
 *  the whole lifecycle: `start()` → negotiated `initialize` → `tools/list`-style
 *  capability capture → `listResources` + `readResource` + `getPrompt` flowing
 *  through the real request/dispatch/pending core → `stop()`. Proves the typed
 *  methods compose with the actual client plumbing, not just the codecs.
 */

import { describe, expect, it } from "bun:test"
import { McpClient } from "@/mcp/client"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

/** A minimal but realistic in-memory MCP server over the transport seam. It
 *  owns a resource catalog + a prompt template and answers the real method
 *  families. `initialize` advertises `resources` (with `subscribe`) + `prompts`
 *  + `tools`. */
class FakeMcpServer implements McpTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null
  readonly inbox: Array<Record<string, unknown>> = []

  private readonly resources = [
    { uri: "mem://readme", name: "README", mimeType: "text/markdown", description: "the readme" },
    { uri: "mem://logo", name: "logo", mimeType: "image/png" },
  ]
  private readonly contents: Record<string, { mimeType: string; text?: string; blob?: string }> = {
    "mem://readme": { mimeType: "text/markdown", text: "# Hello\nworld" },
    "mem://logo": { mimeType: "image/png", blob: "iVBORw0KGgo=" },
  }

  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const msg = payload as Record<string, unknown>
    this.inbox.push(msg)
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      queueMicrotask(() => this.answer(msg.id as number, msg.method as string, msg.params))
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
  private emit(msg: JsonRpcMessage): void {
    this.handler?.(msg)
  }

  private answer(id: number, method: string, params: unknown): void {
    switch (method) {
      case "initialize":
        this.emit({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "fake", version: "1.0" },
            capabilities: { resources: { subscribe: true }, prompts: {}, tools: {} },
          },
        })
        return
      case "resources/list":
        this.emit({ jsonrpc: "2.0", id, result: { resources: this.resources } })
        return
      case "resources/read": {
        const uri = (params as { uri: string }).uri
        const c = this.contents[uri]
        if (c === undefined) {
          this.emit({ jsonrpc: "2.0", id, error: { code: -32602, message: "no such resource" } })
          return
        }
        this.emit({ jsonrpc: "2.0", id, result: { contents: [{ uri, ...c }] } })
        return
      }
      case "prompts/list":
        this.emit({
          jsonrpc: "2.0",
          id,
          result: {
            prompts: [
              {
                name: "greet",
                description: "greet someone",
                arguments: [{ name: "who", required: true }],
              },
            ],
          },
        })
        return
      case "prompts/get": {
        const p = params as { name: string; arguments?: { who?: string } }
        this.emit({
          jsonrpc: "2.0",
          id,
          result: {
            description: "greeting",
            messages: [
              {
                role: "user",
                content: { type: "text", text: `Say hello to ${p.arguments?.who ?? "?"}` },
              },
            ],
          },
        })
        return
      }
      default:
        this.emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
    }
  }
}

const startReady = async (client: McpClient): Promise<void> => {
  const p = client.start()
  await flush()
  await p
}

describe("H19 e2e — real McpClient over a fuller fake MCP server", () => {
  it("initialize → list + read a resource + get a prompt end-to-end", async () => {
    const server = new FakeMcpServer()
    const client = new McpClient({ name: "fake", command: ["x"] }, { transport: server })
    await startReady(client)

    // capabilities captured from initialize
    expect(client.serverSupportsResources()).toBe(true)
    expect(client.serverSupportsResourceSubscribe()).toBe(true)
    expect(client.serverSupportsPrompts()).toBe(true)

    const list = await client.listResources()
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error("unreachable")
    expect(list.value.map((r) => r.uri)).toEqual(["mem://readme", "mem://logo"])

    const readme = await client.readResource("mem://readme")
    expect(readme.ok).toBe(true)
    if (!readme.ok) throw new Error("unreachable")
    expect(readme.value[0]).toEqual({
      uri: "mem://readme",
      mimeType: "text/markdown",
      text: "# Hello\nworld",
    })

    const logo = await client.readResource("mem://logo")
    expect(logo.ok).toBe(true)
    if (!logo.ok) throw new Error("unreachable")
    expect(logo.value[0]?.blob).toBe("iVBORw0KGgo=")
    expect(logo.value[0]?.text).toBeUndefined()

    const prompts = await client.listPrompts()
    expect(prompts.ok).toBe(true)
    if (!prompts.ok) throw new Error("unreachable")
    expect(prompts.value[0]?.name).toBe("greet")

    const got = await client.getPrompt("greet", { who: "Ada" })
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error("unreachable")
    expect(got.value.messages[0]).toEqual({
      role: "user",
      content: { type: "text", text: "Say hello to Ada" },
    })

    await client.stop()
  })

  it("reading a missing resource surfaces a typed transport failure (server -32602), no throw", async () => {
    const server = new FakeMcpServer()
    const client = new McpClient({ name: "fake", command: ["x"] }, { transport: server })
    await startReady(client)

    const missing = await client.readResource("mem://nope")
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error("unreachable")
    expect(missing.reason).toBe("transport")
    expect(missing.message).toContain("no such resource")

    await client.stop()
  })
})
