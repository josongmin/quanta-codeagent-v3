/**
 * MCP protocol-version fail-closed TEARDOWN hellgate (ticket misc-jun-7/01, R1).
 *
 * R1 adversarial finding: the ticket's fail-closed path (a server replying with
 * an unsupported `protocolVersion`) throws an `McpError` from
 * `pinNegotiatedVersion` AFTER a SUCCESSFUL `initialize` round-trip — at which
 * point the transport is already `start()`ed with its message/exit pumps live
 * (and, for HTTP, a standalone SSE GET draining). Before this ticket a server
 * replying with any version connected fine (the reply was discarded), so this is
 * a NEW throw site that must NOT leak a live carrier.
 *
 * These tests assert the in-process client TEARS DOWN the transport when
 * negotiation fails closed (unsupported server version) AND when the §4.c
 * downgrade re-offer ultimately fails. A regression that drops the teardown
 * (reverting to a bare `throw`) re-trips this: the transport stays `closed=false`
 * and the message subscription stays live.
 */
import { describe, expect, test } from "bun:test"
import { McpClient, McpError, type McpServerConfig } from "@/mcp"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
} from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"

type InitOutcome =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }

/** Minimal scripted transport that records `close()` + whether a message
 *  subscription is still live, so a leaked carrier is observable. */
class TornDownTrackingTransport implements McpTransport {
  closed = false
  startedCount = 0
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null

  constructor(private readonly onInitialize: (offered: string) => InitOutcome) {}

  /** True iff a message subscription is still wired (the client never
   *  unsubscribed it). A live pump after a failed start = leak. */
  get subscriptionLive(): boolean {
    return this.msgHandler !== null
  }

  async start(): Promise<void> {
    this.startedCount += 1
  }
  onMessage(handler: McpTransportMessageHandler): () => void {
    this.msgHandler = handler
    return () => {
      this.msgHandler = null
    }
  }
  onExit(handler: McpTransportExitHandler): () => void {
    this.exitHandler = handler
    return () => {
      this.exitHandler = null
    }
  }
  send(payload: unknown): Error | null {
    const p = payload as { id?: number; method?: string; params?: { protocolVersion?: string } }
    if (p.method === "initialize" && typeof p.id === "number") {
      const offered = p.params?.protocolVersion ?? "<missing>"
      const outcome = this.onInitialize(offered)
      const id = p.id
      queueMicrotask(() => {
        if ("error" in outcome) this.inbound({ jsonrpc: "2.0", id, error: outcome.error })
        else this.inbound({ jsonrpc: "2.0", id, result: outcome.result })
      })
    }
    return null
  }
  async close(): Promise<void> {
    this.closed = true
    this.exitHandler?.("closed")
  }
  private inbound(msg: JsonRpcMessage): void {
    this.msgHandler?.(msg)
  }
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "probe",
  command: ["/bin/false"],
  ...over,
})

describe("fail-closed negotiation must not leak the live carrier", () => {
  test("unsupported server version ⇒ McpError AND the transport is closed (no leak)", async () => {
    const t = new TornDownTrackingTransport(() => ({
      result: { protocolVersion: "1999-01-01", capabilities: {} },
    }))
    const c = new McpClient(cfg({ name: "evil" }), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    // The carrier was started by start(); a fail-closed throw must tear it down.
    expect(t.closed).toBe(true)
    expect(t.subscriptionLive).toBe(false)
  })

  test("§4.c double-reject (floor also rejected) ⇒ McpError AND the transport is closed", async () => {
    const t = new TornDownTrackingTransport(() => ({
      error: { code: -32602, message: "no" },
    }))
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    expect(t.closed).toBe(true)
    expect(t.subscriptionLive).toBe(false)
  })

  test("a SUCCESSFUL negotiation does NOT close the transport (no over-teardown)", async () => {
    const t = new TornDownTrackingTransport(() => ({
      result: { protocolVersion: "2025-11-25", capabilities: {} },
    }))
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.closed).toBe(false)
    expect(t.subscriptionLive).toBe(true)
    await c.stop()
    expect(t.closed).toBe(true)
  })
})
