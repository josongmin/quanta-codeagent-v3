/**
 * MCP protocol-version EDGE-STRING hellgate (ticket misc-jun-7/01, R1).
 *
 * R1 hardening: pin the exact boundary behavior for near-miss version strings
 * that an adversarial/buggy server (or a fat-fingered operator) could supply, so
 * the accept/fail-closed boundary can never silently drift to fail-OPEN.
 *
 *   - An OFFER override that is empty / whitespace-padded / a near-miss is
 *     conservatively resolved to LATEST — we NEVER put an unspeakable string on
 *     the wire (the offer is always an exact SSOT member).
 *   - A server-CHOSEN reply that is a non-empty string outside the set
 *     (including a whitespace-padded near-miss of a real version) fails CLOSED,
 *     never proceeds. Only a non-string (absent/malformed shape) is the
 *     legacy-tolerant route-around.
 */
import { describe, expect, test } from "bun:test"
import {
  isSupportedProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpError,
  type McpServerConfig,
  resolveOfferedVersion,
} from "@/mcp"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
} from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"

class OneShotTransport implements McpTransport {
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null
  constructor(private readonly reply: Record<string, unknown>) {}
  async start(): Promise<void> {}
  onMessage(h: McpTransportMessageHandler): () => void {
    this.msgHandler = h
    return () => {
      this.msgHandler = null
    }
  }
  onExit(h: McpTransportExitHandler): () => void {
    this.exitHandler = h
    return () => {
      this.exitHandler = null
    }
  }
  setProtocolVersion(): void {}
  send(payload: unknown): Error | null {
    const p = payload as { id?: number; method?: string }
    if (p.method === "initialize" && typeof p.id === "number") {
      const id = p.id
      queueMicrotask(() => this.msgHandler?.({ jsonrpc: "2.0", id, result: this.reply } as JsonRpcMessage))
    }
    return null
  }
  async close(): Promise<void> {
    this.closed = true
    this.exitHandler?.("closed")
  }
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "probe",
  command: ["/bin/false"],
  ...over,
})

describe("offer-resolution never puts an unspeakable string on the wire", () => {
  test("empty / whitespace / near-miss override ⇒ conservative LATEST", () => {
    expect(resolveOfferedVersion("")).toBe(LATEST_PROTOCOL_VERSION)
    expect(resolveOfferedVersion(" 2025-11-25")).toBe(LATEST_PROTOCOL_VERSION)
    expect(resolveOfferedVersion("2025-11-25 ")).toBe(LATEST_PROTOCOL_VERSION)
    expect(resolveOfferedVersion("2025-11-26")).toBe(LATEST_PROTOCOL_VERSION)
    // The resolved offer is ALWAYS an exact SSOT member.
    expect(isSupportedProtocolVersion(resolveOfferedVersion("garbage"))).toBe(true)
  })
})

describe("server-chosen near-miss strings fail CLOSED (no fail-open drift)", () => {
  test('empty-string protocolVersion ⇒ McpError (NOT legacy-tolerant, NOT silent proceed)', async () => {
    const t = new OneShotTransport({ protocolVersion: "", capabilities: {} })
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
  })

  test('whitespace-padded near-miss of a REAL version ⇒ McpError (exact match only)', async () => {
    const t = new OneShotTransport({ protocolVersion: "2025-06-18 ", capabilities: {} })
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
  })

  test("a non-string protocolVersion (array) ⇒ legacy-tolerant route-around, NOT a throw", async () => {
    const t = new OneShotTransport({ protocolVersion: ["2025-06-18"], capabilities: {} })
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).resolves.toBeUndefined()
    expect(c.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    await c.stop()
  })
})
