/**
 * MCP protocol-version §4.c re-offer — PIN-AFTER-DOWNGRADE hellgate
 * (ticket misc-jun-7/01, R3).
 *
 * Round-3 adversarial probe of what gets PINNED after the §4.c single bounded
 * re-offer succeeds. Prior rounds proved the re-offer fires (and is scoped to a
 * version-rejection) and that the HTTP header re-pins to the floor on the retry
 * POST. NOT previously proven:
 *
 *   1. The re-offer is offer-side ONLY — after the floor re-offer, the SERVER's
 *      chosen reply still drives the pin. A spec-compliant strict server that,
 *      on the floor re-offer, negotiates to YET ANOTHER supported version
 *      (e.g. 2025-03-26, neither the newest nor the floor) must pin THAT — and
 *      re-stamp the transport header to it — not blindly assume the floor. The
 *      `pinNegotiatedVersion` accept branch must run on the retry result.
 *
 *   2. Fail-closed survives the retry: a retry that succeeds at the wire level
 *      but replies an UNSUPPORTED version still fails closed AND tears the
 *      carrier down (the R1 teardown guard must cover the post-re-offer pin, not
 *      just the first-offer pin).
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

class ScriptedTransport implements McpTransport {
  readonly offers: string[] = []
  readonly pins: string[] = []
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null
  constructor(
    private readonly onInit: (
      offered: string,
    ) => { result: Record<string, unknown> } | { error: { code: number; message: string } },
  ) {}
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
  setProtocolVersion(version: string): void {
    this.pins.push(version)
  }
  send(payload: unknown): Error | null {
    const p = payload as { id?: number; method?: string; params?: { protocolVersion?: string } }
    if (p.method === "initialize" && typeof p.id === "number") {
      const offered = p.params?.protocolVersion ?? "<missing>"
      this.offers.push(offered)
      const id = p.id
      const out = this.onInit(offered)
      queueMicrotask(() => {
        if ("error" in out) this.msgHandler?.({ jsonrpc: "2.0", id, error: out.error })
        else this.msgHandler?.({ jsonrpc: "2.0", id, result: out.result })
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

describe("§4.c — the SERVER's reply drives the pin even after a floor re-offer", () => {
  test("re-offer floor ⇒ server replies a THIRD supported version (2025-03-26) ⇒ pin THAT, re-stamp the header", async () => {
    // Strict server rejects the newest (-32602); on the floor re-offer it
    // negotiates to a DIFFERENT supported version than the floor. The pin must
    // follow the server's actual reply, not assume the floor it was offered.
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32602, message: "unsupported" } }
        : { result: { protocolVersion: "2025-03-26", capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    // The session pins the SERVER's chosen version, not the offered floor.
    expect(c.pinnedProtocolVersion()).toBe("2025-03-26")
    // And the transport header was re-stamped to it (the LAST pin wins on the
    // wire), so subsequent requests carry 2025-03-26, not the floor.
    expect(t.pins[t.pins.length - 1]).toBe("2025-03-26")
    await c.stop()
  })

  test("re-offer floor ⇒ server OMITS protocolVersion ⇒ legacy-tolerant pins the FLOOR (the offer that connected)", async () => {
    // After the downgrade, a legacy server that omits the field must pin the
    // version that ACTUALLY connected (the floor), not the original newest offer.
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32602, message: "unsupported" } }
        : { result: { capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(c.pinnedProtocolVersion()).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    await c.stop()
  })
})

describe("§4.c — fail-closed survives the retry (teardown on a post-re-offer unsupported reply)", () => {
  test("retry succeeds at the wire but replies an UNSUPPORTED version ⇒ fail-closed + carrier torn down", async () => {
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32602, message: "unsupported" } }
        : { result: { protocolVersion: "1999-01-01", capabilities: {} } },
    )
    const c = new McpClient(cfg({ name: "evil" }), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    // The R1 teardown guard must cover the post-re-offer pin: the carrier is
    // closed (no leaked transport / subscriptions / SSE socket).
    expect(t.closed).toBe(true)
    expect(c.pinnedProtocolVersion()).toBeNull()
  })
})
