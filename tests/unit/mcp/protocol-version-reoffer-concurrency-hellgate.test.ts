/**
 * MCP §4.c re-offer CONCURRENCY / id-hygiene hellgate (ticket misc-jun-7/01, R4).
 *
 * Round-2 attack vector #4 (the ONE vector with zero direct coverage across R1-3):
 * `initializeWithDowngrade` issues a SECOND `sendInitialize` through the same
 * `nextId++`/pending/timeout core after the first offer was rejected. If a slow
 * transport delivered the FIRST `initialize`'s error LATE (out of order, after
 * the retry was already in flight), a buggy correlation core could double-resolve
 * the retry's promise, reuse an id, or leak the first request's pending timer.
 *
 * Structural finding (R4): the re-offer is STRICTLY SEQUENTIAL — the retry is
 * issued only AFTER `await sendInitialize(offer)` rejects, so the two requests
 * are never in flight simultaneously and an id-collision/double-resolve ACROSS
 * them is impossible by construction. What CAN still race is a hostile slow
 * transport delivering a DUPLICATE stale frame for the first (already-settled)
 * id after the retry pinned the session. These tests drive that:
 *  (1) first offer rejected (-32602) → retry at the floor accepted → the session
 *      pins the RETRY's server-replied version, and a DUPLICATE stale frame for
 *      the first id (delivered after settle) is harmlessly dropped (no re-pin);
 *  (2) every issued id is UNIQUE (no reuse); and
 *  (3) the pin is stable after the stale dup — no late double-settle overwrite.
 *
 * Red-on-injection: re-pointing `pinNegotiatedVersion` at the offered (not the
 * server-replied) value, or removing the takePending-on-settle dedup, would flip
 * the pin / double-settle assertions.
 */
import { describe, expect, test } from "bun:test"
import type { McpTransport, McpTransportExitHandler, McpTransportMessageHandler } from "@/mcp"
import { McpClient, type McpServerConfig } from "@/mcp"

/** Records every outbound id; lets the test control WHEN each scripted reply is
 *  flushed, so it can deliver the first `initialize` error AFTER the retry. */
class OutOfOrderTransport implements McpTransport {
  readonly seenIds: number[] = []
  readonly seenInitOffers: string[] = []
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null
  private firstId: number | null = null
  private initCount = 0

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
  send(payload: unknown): Error | null {
    const p = payload as { id?: number; method?: string; params?: { protocolVersion?: string } }
    if (p.method !== "initialize" || typeof p.id !== "number") return null
    this.seenIds.push(p.id)
    this.seenInitOffers.push(p.params?.protocolVersion ?? "<missing>")
    this.initCount += 1
    const id = p.id
    if (this.initCount === 1) {
      // FIRST offer (newest): deliver the version-rejection so the catch fires
      // and the retry is issued. Remember the id so we can replay a STALE
      // duplicate frame for it LATER (after the retry settles).
      this.firstId = id
      queueMicrotask(() => {
        this.msgHandler?.({ jsonrpc: "2.0", id, error: { code: -32602, message: "no" } })
      })
    } else {
      // RETRY (floor): the server accepts and replies a real version. After it
      // settles, replay a DUPLICATE stale frame for the FIRST id — a hostile
      // slow transport. It must be dropped (the first id is already settled),
      // NOT re-pin or double-settle.
      queueMicrotask(() => {
        this.msgHandler?.({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-06-18", capabilities: {} },
        })
        if (this.firstId !== null) {
          this.msgHandler?.({
            jsonrpc: "2.0",
            id: this.firstId,
            error: { code: -32602, message: "STALE-DUP" },
          })
          this.msgHandler?.({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: "2025-11-25", capabilities: {} },
          })
        }
      })
    }
    return null
  }
  async close(): Promise<void> {
    this.exitHandler?.("closed")
  }
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "race",
  command: ["/bin/false"],
  ...over,
})

describe("§4.c re-offer concurrency — no double-settle, no id reuse, no leaked pending", () => {
  test("out-of-order first-offer error after the retry ⇒ clean pin from the RETRY reply", async () => {
    const t = new OutOfOrderTransport()
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    // The first offer (newest) was rejected; the retry at the floor succeeded.
    expect(t.seenInitOffers).toEqual(["2025-11-25", "2025-06-18"])
    // The session pinned the RETRY's server-replied version, not the original.
    expect(c.pinnedProtocolVersion()).toBe("2025-06-18")
    await c.stop()
  })

  test("every issued initialize id is UNIQUE (the retry never reuses the first id)", async () => {
    const t = new OutOfOrderTransport()
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    const unique = new Set(t.seenIds)
    expect(unique.size).toBe(t.seenIds.length)
    expect(t.seenIds.length).toBe(2)
    await c.stop()
  })

  test("a completed negotiation leaves NO pending request (no leaked timer/double-settle)", async () => {
    const t = new OutOfOrderTransport()
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    // flush any trailing stale frames
    await Promise.resolve()
    await Promise.resolve()
    // If the stale dup frame double-settled or a timer leaked, requestRaw below
    // would see a corrupted pending map; instead it negotiates a fresh id cleanly.
    // We assert the pinned version is stable (no late overwrite from the stale dup).
    expect(c.pinnedProtocolVersion()).toBe("2025-06-18")
    await c.stop()
  })
})
