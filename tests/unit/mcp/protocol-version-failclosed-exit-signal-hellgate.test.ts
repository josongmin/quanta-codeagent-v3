/**
 * MCP protocol-version fail-closed EXIT-SIGNAL hellgate (ticket misc-jun-7/01, R4).
 *
 * R4 adversarial finding (round-3 attack vector #3, never tested): the ticket's
 * fail-closed teardown (R1) calls `this.stop()` inside `start()` when negotiation
 * fails closed (unsupported server `protocolVersion`) or the §4.c re-offer is
 * double-rejected. `stop()` awaits `transport.close()`, and a real HTTP transport
 * fires its EXIT handler from `close()` (`http-sse.ts close()` → `fireExit`). The
 * client routes that to `onTransportExit()`, which fans out a `"transport exit"`
 * to EXTERNAL subscribers — the ADR-0435 auto-restart supervisor.
 *
 * The hazard: a DELIBERATE fail-closed teardown (the operator's server replied
 * with a version we don't speak — a permanent, NOT-restartable condition) must
 * NOT masquerade as a crash. If a wired supervisor receives a spurious
 * `"process/transport exit"` it would crash-loop-restart a server that will
 * fail-close again every time — an infinite reconnect storm on an unsupported
 * peer. A `start()` that throws a typed `McpError` is the caller's signal; the
 * supervisor's exit channel must stay SILENT for a teardown the client itself
 * initiated.
 *
 * Red-on-injection: before the fix, the in-process client unsubscribes its exit
 * handler AFTER `await transport.close()` (so a synchronous HTTP `fireExit` slips
 * through), and the isolated client's fail-closed catch nulls `host`/`started`
 * but never sets `stopped` — so `host.stop()` → `exitPromise` → `notifyExit`
 * fires the supervisor. Both emit a spurious exit; this test catches both.
 */
import { describe, expect, test } from "bun:test"
import { McpClient, McpError, type McpServerConfig } from "@/mcp"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
} from "@/mcp"

type InitOutcome =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }

/** A transport whose `close()` fires the exit handler SYNCHRONOUSLY — exactly
 *  what `HttpSseMcpTransport.close()` does (`fireExit` at the tail of `close`).
 *  This is the realistic carrier that exposes the spurious-exit fan-out. */
class HttpLikeExitOnCloseTransport implements McpTransport {
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null

  constructor(private readonly onInitialize: (offered: string) => InitOutcome) {}

  async start(): Promise<void> {}
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
        if ("error" in outcome) this.msgHandler?.({ jsonrpc: "2.0", id, error: outcome.error })
        else this.msgHandler?.({ jsonrpc: "2.0", id, result: outcome.result })
      })
    }
    return null
  }
  async close(): Promise<void> {
    this.closed = true
    // Mirror HttpSseMcpTransport.close(): fire the exit handler as part of close.
    this.exitHandler?.(`mcp server closed`)
  }
  /** Simulate an UNSOLICITED carrier death (server crash) — NOT a client stop. */
  simulateCrash(reason: string): void {
    this.exitHandler?.(reason)
  }
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "probe",
  command: ["/bin/false"],
  ...over,
})

describe("in-process: fail-closed teardown must NOT signal a spurious exit to a wired supervisor", () => {
  test("unsupported version ⇒ throws, but the external exit handler is NEVER called", async () => {
    const t = new HttpLikeExitOnCloseTransport(() => ({
      result: { protocolVersion: "1999-01-01", capabilities: {} },
    }))
    const c = new McpClient(cfg({ name: "evil" }), { transport: t })
    const exitReasons: (string | undefined)[] = []
    // A wired ADR-0435 auto-restart supervisor.
    c.onExit((reason) => exitReasons.push(reason))

    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    // give any queued microtasks / fire-and-forget teardown a tick to flush
    await Promise.resolve()
    await Promise.resolve()

    expect(t.closed).toBe(true)
    // The deliberate fail-closed teardown must NOT look like a crash.
    expect(exitReasons).toEqual([])
  })

  test("§4.c double-reject ⇒ throws, but the external exit handler is NEVER called", async () => {
    const t = new HttpLikeExitOnCloseTransport(() => ({
      error: { code: -32602, message: "no" },
    }))
    const c = new McpClient(cfg(), { transport: t })
    const exitReasons: (string | undefined)[] = []
    c.onExit((reason) => exitReasons.push(reason))

    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    await Promise.resolve()
    await Promise.resolve()

    expect(t.closed).toBe(true)
    expect(exitReasons).toEqual([])
  })

  test("a REAL transport exit (server crash) STILL fans out — the supervisor channel is not broken", async () => {
    const t = new HttpLikeExitOnCloseTransport(() => ({
      result: { protocolVersion: "2025-11-25", capabilities: {} },
    }))
    const c = new McpClient(cfg(), { transport: t })
    const exitReasons: (string | undefined)[] = []
    c.onExit((reason) => exitReasons.push(reason))

    await c.start()
    expect(exitReasons).toEqual([])
    // Simulate an unsolicited carrier death (NOT a client-initiated stop).
    t.simulateCrash("server crashed")
    expect(exitReasons.length).toBe(1)
  })
})
