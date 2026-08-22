/**
 * MCP protocol-version §4.c re-offer — HOSTILE error-code SHAPE hellgate
 * (ticket misc-jun-7/01, R3).
 *
 * Round-3 adversarial probe of the structured `jsonRpcCode` plumbing the R2
 * round added to scope the §4.c re-offer. `resolveResponse` extracts the code
 * with `typeof msg.error.code === "number"` and the catch fires the floor
 * re-offer ONLY when that number is an exact member of `{-32602, -32600}`.
 *
 * A hostile/buggy server can send `code` in many non-canonical shapes. The
 * invariant under attack: NONE of these may
 *   (a) FAIL OPEN — spuriously trigger a floor re-offer (a wasted round-trip /
 *       a silent downgrade) when the error is NOT a genuine version-rejection, OR
 *   (b) corrupt the typed-error message text (every existing message assertion
 *       must stay byte-identical — the text uses the RAW code, not the parsed one).
 *
 * These pin the boundary so the structured signal can never drift to fail-open.
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

/** A scripted transport that answers the FIRST `initialize` (the newest offer)
 *  with a caller-supplied JSON-RPC `error` object (whose `code` may be any
 *  shape), and the SECOND `initialize` (the floor re-offer, if one happens) with
 *  a clean accept. Records every offer so a spurious re-offer is observable. */
class CodeShapeTransport implements McpTransport {
  readonly offers: string[] = []
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null
  constructor(private readonly firstError: Record<string, unknown>) {}
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
      const id = p.id
      const isFirst = this.offers.length === 1
      queueMicrotask(() => {
        if (isFirst) {
          // Deliver the hostile error envelope verbatim.
          this.msgHandler?.({ jsonrpc: "2.0", id, error: this.firstError } as never)
        } else {
          this.msgHandler?.({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} },
          })
        }
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

/** Each case: a JSON-RPC error whose `code` is a hostile/non-canonical shape
 *  that is NOT a genuine version-rejection. The §4.c re-offer must NOT fire, so
 *  the client must reject on the FIRST offer (offers.length === 1). */
const NON_REJECTION_CODES: ReadonlyArray<{ label: string; code: unknown }> = [
  { label: "negative zero (-0)", code: -0 },
  { label: "float near-miss (-32602.5)", code: -32602.5 },
  // -32602.0 === -32602 in JS, so that one IS a rejection — excluded here.
  { label: "string '-32602'", code: "-32602" },
  { label: "NaN", code: Number.NaN },
  { label: "Infinity", code: Number.POSITIVE_INFINITY },
  { label: "-Infinity", code: Number.NEGATIVE_INFINITY },
  { label: "boolean true", code: true },
  { label: "null", code: null },
  { label: "object", code: { v: -32602 } },
  { label: "Internal -32603", code: -32603 },
  { label: "transport synth -32000", code: -32000 },
]

describe("§4.c re-offer never FAILS OPEN on a hostile error-code shape", () => {
  for (const { label, code } of NON_REJECTION_CODES) {
    test(`code = ${label} does NOT trigger a floor re-offer`, async () => {
      const t = new CodeShapeTransport({ code, message: "nope" })
      const c = new McpClient(cfg(), { transport: t })
      await expect(c.start()).rejects.toBeInstanceOf(McpError)
      // The load-bearing assertion: exactly ONE offer. A fail-open re-offer
      // would make this 2 (and silently pin the floor).
      expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION])
      expect(c.pinnedProtocolVersion()).toBeNull()
    })
  }

  test("the genuine -32602 (control) DOES re-offer — proves the guard is not vacuous", async () => {
    const t = new CodeShapeTransport({ code: -32602, message: "unsupported protocolVersion" })
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    await c.stop()
  })

  test("a float that EQUALS the rejection code (-32602.0 === -32602) re-offers (JS number identity)", async () => {
    // -32602.0 is the SAME number as -32602 in JS, so the rejection set matches.
    // This is correct (it IS InvalidParams), pinned so a future change to the
    // extraction can't silently start dropping integer-valued floats.
    const t = new CodeShapeTransport({ code: -32602.0, message: "unsupported" })
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    await c.stop()
  })
})

describe("hostile error-code shape does NOT corrupt the typed-error message text", () => {
  test("a string code still renders in the message (raw code used for text)", async () => {
    // The message text uses the RAW `error.code`, so a non-number code must still
    // render — the structured extraction (number-only) is a SEPARATE channel.
    const t = new CodeShapeTransport({ code: "weird-code", message: "boom" })
    const c = new McpClient(cfg(), { transport: t })
    let caught: Error | null = null
    try {
      await c.start()
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(McpError)
    expect(caught?.message).toContain("weird-code")
    expect(caught?.message).toContain("boom")
    // And no spurious re-offer happened (string code is not a rejection).
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION])
  })
})
