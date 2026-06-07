/**
 * MCP protocol-version §4.c re-offer SCOPE hellgate (ticket misc-jun-7/01, R2).
 *
 * Round-2 adversarial probe of the single bounded re-offer in
 * `McpClient.initializeWithDowngrade`. The ticket §4.c scopes the re-offer to a
 * VERSION-REJECTION ("a JSON-RPC `error`, e.g. `InvalidParams -32602`"). The R1
 * audit flagged that the catch fires on ANY `McpError` — including a request
 * TIMEOUT, a connection-level transport failure, and a non-version server error
 * (Internal -32603, a -32000 transport synth). Those are NOT version
 * rejections, so re-offering the FLOOR on them is wrong on two counts:
 *
 *   1. It burns a second `initialize` round-trip on a transient/unrelated fault
 *      (waste — the §5 "one extra round-trip" budget is for strict-old servers,
 *      not for every transient error).
 *   2. WORSE — silent capability loss: a server that genuinely supports the
 *      NEWEST version but hiccups on the first `initialize` (timeout / transient
 *      500) gets its NEWEST offer abandoned, the FLOOR offered on retry, and if
 *      the retry succeeds the session is pinned to the OLDER protocol. A
 *      transient fault is masked as a permanent version incompatibility.
 *
 * These tests pin the re-offer to a version-rejection ONLY. They fail RED
 * against an over-broad `instanceof McpError` catch and go green once the catch
 * is narrowed to a JSON-RPC version-rejection (the -32602 / -32600 InvalidParams
 * / InvalidRequest family the spec uses for an unspeakable `initialize`).
 *
 * Every test drives an in-memory transport double — no subprocess, no network.
 */
import { describe, expect, test } from "bun:test"
import {
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpError,
  type McpServerConfig,
  type McpTransport,
  type McpTransportExitHandler,
  type McpTransportMessageHandler,
  PROTOCOL_DOWNGRADE_FLOOR,
} from "@/mcp"

type InitReply =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
  | { silent: true } // never reply → drive the client's request timeout

/** Scripted transport that records every offer and lets the test choose, per
 *  offered version, whether to reply success / JSON-RPC error / never (timeout). */
class ScriptedTransport implements McpTransport {
  readonly offers: string[] = []
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null
  constructor(private readonly onInit: (offered: string) => InitReply) {}
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
    const p = payload as { id?: number; method?: string; params?: { protocolVersion?: string } }
    if (p.method === "initialize" && typeof p.id === "number") {
      const offered = p.params?.protocolVersion ?? "<missing>"
      this.offers.push(offered)
      const reply = this.onInit(offered)
      const id = p.id
      if ("silent" in reply) return null
      queueMicrotask(() => {
        if ("error" in reply) this.msgHandler?.({ jsonrpc: "2.0", id, error: reply.error })
        else this.msgHandler?.({ jsonrpc: "2.0", id, result: reply.result })
      })
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

/** Force a fast timeout so the timeout-driven test doesn't wait the 30s default. */
const withFastTimeout = (c: McpClient): McpClient => {
  ;(c as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 50
  return c
}

describe("§4.c re-offer is scoped to a VERSION-REJECTION, not any McpError", () => {
  test("a NON-version JSON-RPC error (Internal -32603) does NOT trigger a floor re-offer", async () => {
    // The server answers the newest offer with an Internal error — a transient
    // server fault, NOT a version rejection. The client must NOT downgrade-probe.
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32603, message: "internal error, retry later" } }
        : { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    // The bug: an over-broad catch re-offers the floor → offers.length === 2.
    // Correct: a non-version error propagates on the FIRST offer → length === 1.
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION])
  })

  test("a request TIMEOUT on the newest offer does NOT trigger a floor re-offer", async () => {
    // The server never answers the newest offer (a hung/slow initialize). A
    // timeout is an McpError but is NOT a version rejection. Re-offering the
    // floor here would mask a transient hang as a version incompatibility AND
    // silently downgrade the session if the floor happens to succeed.
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { silent: true }
        : { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } },
    )
    const c = withFastTimeout(new McpClient(cfg(), { transport: t }))
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION])
  })

  test("silent capability-loss guard: a transient fault must NOT pin the floor", async () => {
    // Server genuinely supports the NEWEST version, but the FIRST initialize
    // hits a transient Internal error. Over-broad re-offer would downgrade to
    // the floor and connect — pinning the OLDER protocol for the whole session,
    // a silent capability loss. The narrowed catch fails the connect instead
    // (the operator retries / pins via QUANTA_MCP_PROTOCOL_MAX), never silently
    // sitting on a stale version.
    let firstNewest = true
    const t = new ScriptedTransport((offered) => {
      if (offered === LATEST_PROTOCOL_VERSION && firstNewest) {
        firstNewest = false
        return { error: { code: -32603, message: "transient" } }
      }
      // The floor would succeed — proving the only thing stopping a silent
      // downgrade is the narrowed catch, not the server's behavior.
      return { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } }
    })
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    // Never reached the floor (would be the silent downgrade).
    expect(c.pinnedProtocolVersion()).toBeNull()
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION])
  })

  test("a genuine version-rejection (-32602) STILL re-offers the floor (no regression)", async () => {
    // The narrowing must not break the real §4.c path: an InvalidParams -32602
    // (the spec's version-rejection code) must still trigger exactly one floor
    // re-offer and connect.
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32602, message: "unsupported protocolVersion" } }
        : { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    expect(c.pinnedProtocolVersion()).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    await c.stop()
  })

  test("a transport-synth error (-32000, e.g. HTTP 401/500) does NOT re-offer", async () => {
    // The HTTP transport synthesizes JSON-RPC `code: -32000` for a non-2xx /
    // connection failure (incl. a 401). That is NOT a version-rejection, so it
    // must propagate on the first offer — never burning a second initialize
    // round-trip (and never double-driving an OAuth reauth, the R1 concern).
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32000, message: "transport POST failed: HTTP 401" } }
        : { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION])
  })

  test("an InvalidRequest -32600 version-rejection also re-offers (spec families)", async () => {
    // Some strict servers answer an unspeakable initialize with -32600
    // (InvalidRequest) rather than -32602 (InvalidParams). Both are the JSON-RPC
    // request-rejection family the spec uses for a bad initialize, so the
    // re-offer must cover both.
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32600, message: "invalid request" } }
        : { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    await c.stop()
  })
})
