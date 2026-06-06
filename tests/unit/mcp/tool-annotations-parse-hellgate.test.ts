/** §19.1 / §19.3 — MCP `ToolAnnotations` + non-text media PARSE hellgate.
 *
 *  Pure-parser layer (no bridge, no permission machine). Proves the `@/mcp`
 *  slice:
 *    - sanitizeAnnotations lifts ONLY real JSON booleans; a poisoned
 *      `readOnlyHint:"true"` / `1` / `{}` / `null` is DROPPED (never coerced).
 *    - garbage / non-object annotations ⇒ undefined (absent stays absent).
 *    - mapTool attaches sanitized annotations through `listTools()`.
 *    - extractMedia lifts image (`data`+`mimeType`) and embedded resource
 *      (`resource.blob`+`mimeType`) blocks; a malformed block is skipped, never
 *      throws; text blocks are left out of media.
 *    - callTool surfaces `media` only when non-empty (text-only ⇒ byte-identical
 *      result with no `media` key). */

import { describe, expect, test } from "bun:test"
import { extractMedia, McpClient, sanitizeAnnotations } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport, McpTransportMessageHandler } from "@/mcp/transports/port"

class ScriptedTransport implements McpTransport {
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: (() => void) | null = null
  constructor(
    private readonly responder: (method: string, params: unknown) => Record<string, unknown> | null,
  ) {}
  async start(): Promise<void> {}
  onMessage(h: McpTransportMessageHandler): () => void {
    this.msgHandler = h
    return () => {
      this.msgHandler = null
    }
  }
  onExit(h: () => void): () => void {
    this.exitHandler = h
    return () => {
      this.exitHandler = null
    }
  }
  send(payload: unknown): Error | null {
    const msg = payload as { id?: number | string; method?: string; params?: unknown }
    if (msg.method === undefined) return null
    if (typeof msg.id !== "number" && typeof msg.id !== "string") return null
    const result = this.responder(msg.method, msg.params)
    if (result === null) return null
    const reply: JsonRpcMessage = { jsonrpc: "2.0", id: msg.id, result }
    queueMicrotask(() => this.msgHandler?.(reply))
    return null
  }
  async close(): Promise<void> {
    this.exitHandler?.()
  }
}

const initResult = (): Record<string, unknown> => ({
  protocolVersion: "2025-06-18",
  serverInfo: { name: "mock", version: "0.0.1" },
  capabilities: { tools: {} },
})

describe("sanitizeAnnotations — boolean-only, poison-proof", () => {
  test("lifts real JSON booleans only", () => {
    expect(
      sanitizeAnnotations({
        title: "T",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      }),
    ).toEqual({
      title: "T",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  test('poisoned readOnlyHint:"true" (string) is DROPPED, never coerced', () => {
    const out = sanitizeAnnotations({ readOnlyHint: "true" })
    // no usable boolean field ⇒ whole object collapses to undefined
    expect(out).toBeUndefined()
  })

  test("poisoned numeric / object / null hints are dropped", () => {
    expect(sanitizeAnnotations({ readOnlyHint: 1, idempotentHint: {} })).toBeUndefined()
    expect(sanitizeAnnotations({ readOnlyHint: null })).toBeUndefined()
  })

  test("mixed: real boolean survives, poisoned sibling dropped", () => {
    expect(sanitizeAnnotations({ readOnlyHint: true, idempotentHint: "yes" })).toEqual({
      readOnlyHint: true,
    })
  })

  test("non-object input ⇒ undefined", () => {
    expect(sanitizeAnnotations(undefined)).toBeUndefined()
    expect(sanitizeAnnotations("readOnlyHint")).toBeUndefined()
    expect(sanitizeAnnotations(["readOnlyHint"])).toBeUndefined()
    expect(sanitizeAnnotations(42)).toBeUndefined()
    expect(sanitizeAnnotations(null)).toBeUndefined()
  })

  test("title-only (no booleans) is carried as display-only", () => {
    expect(sanitizeAnnotations({ title: "Friendly" })).toEqual({ title: "Friendly" })
  })
})

describe("extractMedia — non-text content blocks", () => {
  test("image block with data+mimeType ⇒ image media", () => {
    expect(extractMedia([{ type: "image", data: "AAAA", mimeType: "image/png" }])).toEqual([
      { kind: "image", data: "AAAA", mimeType: "image/png" },
    ])
  })

  test("embedded resource blob+mimeType ⇒ resource media", () => {
    expect(
      extractMedia([
        { type: "resource", resource: { blob: "QkxPQg==", mimeType: "application/pdf" } },
      ]),
    ).toEqual([{ kind: "resource", data: "QkxPQg==", mimeType: "application/pdf" }])
  })

  test("text blocks are not media", () => {
    expect(extractMedia([{ type: "text", text: "hi" }])).toEqual([])
  })

  test("malformed blocks are skipped, never throw", () => {
    expect(
      extractMedia([
        { type: "image" }, // no data/mimeType
        { type: "image", data: "X" }, // no mimeType
        { type: "resource", resource: { blob: "X" } }, // no mimeType
        { type: "resource" }, // no resource
        { type: "audio", data: "X", mimeType: "audio/wav" }, // unsupported kind
      ]),
    ).toEqual([])
  })

  test("undefined content ⇒ empty", () => {
    expect(extractMedia(undefined)).toEqual([])
  })
})

describe("client — listTools / callTool ingestion", () => {
  test("listTools attaches sanitized annotations + drops poison", async () => {
    const transport = new ScriptedTransport((method) => {
      if (method === "initialize") return initResult()
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "ro",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true, idempotentHint: true },
            },
            {
              name: "poison",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: "true" },
            },
            { name: "bare", inputSchema: { type: "object" } },
          ],
        }
      }
      return {}
    })
    const client = new McpClient({ name: "mock", command: ["x"] }, { transport })
    await client.start()
    const defs = await client.listTools()
    expect(defs[0]?.annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
    // poisoned string hint ⇒ no annotations object at all
    expect(defs[1]?.annotations).toBeUndefined()
    expect(defs[2]?.annotations).toBeUndefined()
    await client.stop()
  })

  test("callTool surfaces media; text-only result has NO media key", async () => {
    const transport = new ScriptedTransport((method, params) => {
      if (method === "initialize") return initResult()
      if (method === "tools/list") return { tools: [] }
      if (method === "tools/call") {
        const name = (params as { name?: string }).name
        if (name === "withimg") {
          return {
            content: [
              { type: "text", text: "see image" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
          }
        }
        return { content: [{ type: "text", text: "plain" }] }
      }
      return {}
    })
    const client = new McpClient({ name: "mock", command: ["x"] }, { transport })
    await client.start()
    const withImg = await client.callTool("withimg", {})
    expect(withImg.content).toBe("see image")
    expect(withImg.media).toEqual([{ kind: "image", data: "AAAA", mimeType: "image/png" }])
    const plain = await client.callTool("plain", {})
    expect(plain.content).toBe("plain")
    // byte-identical text-only result: media absent
    expect(plain.media).toBeUndefined()
    await client.stop()
  })
})
