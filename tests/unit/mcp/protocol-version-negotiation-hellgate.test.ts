/**
 * MCP protocol-version negotiation hellgate (ticket misc-jun-7/01).
 *
 * Adversarial proofs for the negotiated supported-set handshake:
 *   - newest-first SSOT (single source; no per-call-site re-divergence),
 *   - offer-newest / accept-server-choice / pin-to-server-choice,
 *   - legacy-tolerant (server omits protocolVersion),
 *   - fail-closed on a version we do not implement (Codex UNSUPPORTED_PROTOCOL),
 *   - §4.c single bounded re-offer to the floor on a strict-server rejection,
 *   - the `QUANTA_MCP_PROTOCOL_MAX` byte-identical pin-back,
 *   - the §7 single-source ratchet (the permanent triplication guard),
 *   - malformed protocolVersion routes around (never throws on shape),
 *   - isError-result vs McpError-throw distinction is preserved.
 *
 * Every test drives an in-memory transport double — no subprocess, no network.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  isSupportedProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpError,
  type McpServerConfig,
  type McpTransport,
  type McpTransportExitHandler,
  type McpTransportMessageHandler,
  PROTOCOL_DOWNGRADE_FLOOR,
  resolveOfferedVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"

const REPO = join(import.meta.dir, "..", "..", "..")

/** A scripted in-memory transport. The test supplies an `onInitialize` that,
 *  given the OFFERED version, returns either a success `result` (optionally with
 *  a `protocolVersion`) OR a JSON-RPC `error` envelope (strict-server reject).
 *  Records every offered version + every `setProtocolVersion` pin so the wire
 *  contract is fully observable. */
type InitOutcome =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }

class ScriptedTransport implements McpTransport {
  readonly offers: string[] = []
  readonly pins: string[] = []
  /** The header value a real carrier would stamp (the latest pin / offer). */
  headerVersion = "<unset>"
  started = false
  closed = false
  private msgHandler: McpTransportMessageHandler | null = null
  private exitHandler: McpTransportExitHandler | null = null

  constructor(private readonly onInitialize: (offered: string) => InitOutcome) {}

  async start(): Promise<void> {
    this.started = true
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
  setProtocolVersion(version: string): void {
    this.pins.push(version)
    this.headerVersion = version
  }
  send(payload: unknown): Error | null {
    const p = payload as { id?: number; method?: string; params?: { protocolVersion?: string } }
    if (p.method === "initialize" && typeof p.id === "number") {
      const offered = p.params?.protocolVersion ?? "<missing>"
      this.offers.push(offered)
      this.headerVersion = offered
      const outcome = this.onInitialize(offered)
      const id = p.id
      queueMicrotask(() => {
        if ("error" in outcome) {
          this.inbound({ jsonrpc: "2.0", id, error: outcome.error })
        } else {
          this.inbound({ jsonrpc: "2.0", id, result: outcome.result })
        }
      })
    }
    return null
  }
  async close(): Promise<void> {
    this.closed = true
    this.exitHandler?.("closed")
  }
  inbound(msg: JsonRpcMessage): void {
    this.msgHandler?.(msg)
  }
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "probe",
  command: ["/bin/false"],
  ...over,
})

describe("SSOT — newest-first supported set", () => {
  test("list matches the Cursor/Claude-Code-IDE five, newest first", () => {
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
      "2024-10-07",
    ])
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25")
    expect(PROTOCOL_DOWNGRADE_FLOOR).toBe("2025-06-18")
  })

  test("isSupportedProtocolVersion accepts only exact set members", () => {
    expect(isSupportedProtocolVersion("2025-11-25")).toBe(true)
    expect(isSupportedProtocolVersion("2025-06-18")).toBe(true)
    expect(isSupportedProtocolVersion("1999-01-01")).toBe(false)
    expect(isSupportedProtocolVersion("")).toBe(false)
    expect(isSupportedProtocolVersion(undefined)).toBe(false)
    expect(isSupportedProtocolVersion(20251125)).toBe(false)
    expect(isSupportedProtocolVersion(null)).toBe(false)
  })

  test("resolveOfferedVersion: absent ⇒ newest; supported ⇒ pin; unsupported ⇒ newest", () => {
    expect(resolveOfferedVersion(undefined)).toBe("2025-11-25")
    expect(resolveOfferedVersion("2025-06-18")).toBe("2025-06-18")
    // An unknown override never reaches the wire — conservative fallback.
    expect(resolveOfferedVersion("bogus")).toBe("2025-11-25")
  })
})

describe("negotiation — accept / downgrade-reply / legacy-tolerant", () => {
  test("offers newest by default and pins the server's exact choice", async () => {
    const t = new ScriptedTransport(() => ({
      result: { protocolVersion: "2025-11-25", capabilities: {} },
    }))
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    expect(t.offers).toEqual(["2025-11-25"])
    expect(c.pinnedProtocolVersion()).toBe("2025-11-25")
    expect(t.headerVersion).toBe("2025-11-25")
    await c.stop()
  })

  test("negotiate-down: server replies 2025-06-18 ⇒ accept + pin the OLDER value", async () => {
    // Offer newest; spec-compliant old-only server downgrades in its REPLY.
    const t = new ScriptedTransport(() => ({
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    }))
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    // Offered the newest, but pinned the server's chosen older version. The
    // header now carries the PINNED value, not the offered one.
    expect(t.offers).toEqual(["2025-11-25"])
    expect(c.pinnedProtocolVersion()).toBe("2025-06-18")
    expect(t.headerVersion).toBe("2025-06-18")
    await c.stop()
  })

  test("legacy-tolerant: server omits protocolVersion ⇒ pin the offered value, no throw", async () => {
    const t = new ScriptedTransport(() => ({ result: { capabilities: {} } }))
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).resolves.toBeUndefined()
    expect(c.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    expect(t.headerVersion).toBe(LATEST_PROTOCOL_VERSION)
    await c.stop()
  })

  test("malformed protocolVersion (non-string) ⇒ legacy-tolerant, never throws", async () => {
    const t = new ScriptedTransport(() => ({
      result: { protocolVersion: 20251125, capabilities: {} },
    }))
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).resolves.toBeUndefined()
    expect(c.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    await c.stop()
  })
})

describe("fail-closed — unsupported server-chosen version (Codex UNSUPPORTED_PROTOCOL)", () => {
  test("server picks a version NOT in our set ⇒ typed McpError, no silent proceed", async () => {
    const t = new ScriptedTransport(() => ({
      result: { protocolVersion: "1999-01-01", capabilities: {} },
    }))
    const c = new McpClient(cfg({ name: "evil" }), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    try {
      await new McpClient(cfg({ name: "evil" }), {
        transport: new ScriptedTransport(() => ({
          result: { protocolVersion: "1999-01-01", capabilities: {} },
        })),
      }).start()
      expect("should-have-thrown").toBe("but-did-not")
    } catch (e) {
      expect(e).toBeInstanceOf(McpError)
      expect((e as Error).message).toContain("unsupported protocolVersion")
      expect((e as Error).message).toContain("1999-01-01")
    }
  })
})

describe("§4.c — single bounded re-offer to the floor on a strict-server reject", () => {
  test("strict server rejects newest with -32602 ⇒ exactly ONE re-offer at the floor ⇒ connect", async () => {
    const t = new ScriptedTransport((offered) =>
      offered === LATEST_PROTOCOL_VERSION
        ? { error: { code: -32602, message: "unsupported protocol version" } }
        : { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } },
    )
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    // Exactly two offers: newest, then the floor. No unbounded probe.
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
    expect(c.pinnedProtocolVersion()).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    await c.stop()
  })

  test("a SECOND rejection (floor also rejected) propagates — bounded, never loops", async () => {
    let calls = 0
    const t = new ScriptedTransport(() => {
      calls += 1
      return { error: { code: -32602, message: "no" } }
    })
    const c = new McpClient(cfg(), { transport: t })
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    // Two attempts max: the newest offer + the single floor re-offer.
    expect(calls).toBe(2)
    expect(t.offers).toEqual([LATEST_PROTOCOL_VERSION, PROTOCOL_DOWNGRADE_FLOOR])
  })
})

describe("knob — QUANTA_MCP_PROTOCOL_MAX pins the offer back (byte-identical)", () => {
  test("pinned to the floor ⇒ offer is the floor AND no re-offer probe occurs", async () => {
    // We cannot mutate runtimeConfig() (frozen, env-cached) inside the test, so
    // we exercise the resolver directly + assert the client offers whatever the
    // resolver returns. With the floor offered, a server that rejects the floor
    // has NOWHERE to downgrade, so there is exactly ONE attempt (no probe).
    expect(resolveOfferedVersion(PROTOCOL_DOWNGRADE_FLOOR)).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    // Simulate the floor-pinned client by injecting a transport whose first
    // (and only) offer is the floor: a reject must propagate with NO second
    // attempt, proving floor offers are not re-probed.
    let calls = 0
    const t = new ScriptedTransport((offered) => {
      calls += 1
      // The floor-pinned client would never offer newest; if it ever did, this
      // assertion would catch the regression.
      expect(offered).toBe(PROTOCOL_DOWNGRADE_FLOOR)
      return { result: { protocolVersion: PROTOCOL_DOWNGRADE_FLOOR, capabilities: {} } }
    })
    // Drive the floor offer by stubbing the client's resolved offer.
    const c = new McpClient(cfg(), { transport: t })
    ;(c as unknown as { offeredVersion: string }).offeredVersion = PROTOCOL_DOWNGRADE_FLOOR
    await c.start()
    expect(calls).toBe(1)
    expect(t.offers).toEqual([PROTOCOL_DOWNGRADE_FLOOR])
    expect(c.pinnedProtocolVersion()).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    await c.stop()
  })

  test("a floor-offer that the server REJECTS does NOT re-probe (no downgrade below the floor)", async () => {
    let calls = 0
    const t = new ScriptedTransport(() => {
      calls += 1
      return { error: { code: -32602, message: "no" } }
    })
    const c = new McpClient(cfg(), { transport: t })
    ;(c as unknown as { offeredVersion: string }).offeredVersion = PROTOCOL_DOWNGRADE_FLOOR
    await expect(c.start()).rejects.toBeInstanceOf(McpError)
    expect(calls).toBe(1) // no re-offer when the floor is already what we offered
  })
})

describe("isError-result vs McpError-throw distinction preserved (§3)", () => {
  test("a tools/call returning isError:true ⇒ ok:false RESULT, not a throw", async () => {
    const t = new ScriptedTransport(() => ({
      result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} } },
    })) as ScriptedTransport & { send(p: unknown): Error | null }
    // Extend send to answer tools/call with an isError result.
    const baseSend = t.send.bind(t)
    ;(t as unknown as { send: (p: unknown) => Error | null }).send = (payload: unknown) => {
      const p = payload as { id?: number; method?: string }
      if (p.method === "tools/call" && typeof p.id === "number") {
        const id = p.id
        queueMicrotask(() =>
          t.inbound({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "boom" }], isError: true },
          }),
        )
        return null
      }
      return baseSend(payload)
    }
    const c = new McpClient(cfg(), { transport: t })
    await c.start()
    const res = await c.callTool("x", {})
    expect(res.ok).toBe(false)
    expect(res.content).toBe("boom")
    await c.stop()
  })
})

describe("§7 SSOT single-source ratchet — the permanent triplication guard", () => {
  const readSrc = (rel: string): string => readFileSync(join(REPO, rel), "utf8")

  test("the offered-version literals live ONLY in protocol-version.ts", () => {
    // The two negotiated version literals must NOT be re-introduced as an
    // independent constant in any client/transport. They are allowed only in
    // the SSOT module (and as doc-comment text). Removing the SSOT and inlining
    // a `const PROTOCOL_VERSION = "2025-06-18"` again would re-trip this.
    const offenders = [
      "src/mcp/client.ts",
      "src/mcp/isolated-client.ts",
      "src/mcp/transports/http-sse.ts",
    ]
    // R2 hardening — the assignment-only regex (`=\s*"<ver>"`) let an
    // array-literal (`["2025-06-18", …]`) or a quoted literal used as a call
    // argument re-introduce the triplication. Forbid ANY *quoted* version-string
    // literal in a consumer file (the SSOT is the only place a version string is
    // quoted). Doc-comments mention versions UNQUOTED (`spec 2025-06-18`), so the
    // quote-anchored guard catches a real re-divergence without false-tripping on
    // prose. Covers `'…'`, `"…"`, and template `` `…` `` forms.
    const quotedVersionLiteral = (ver: string): RegExp => new RegExp(`["'\`]${ver}["'\`]`)
    for (const file of offenders) {
      const src = readSrc(file)
      // No file may assign a protocol-version string to a const/let/var.
      expect(src).not.toMatch(/=\s*"2025-06-18"/)
      expect(src).not.toMatch(/=\s*"2025-11-25"/)
      // No file may carry ANY quoted version-string literal (array element, call
      // arg, template) for ANY member of the SSOT set — that is the SSOT's job.
      for (const ver of SUPPORTED_PROTOCOL_VERSIONS) {
        expect(src).not.toMatch(quotedVersionLiteral(ver))
      }
    }
    // The SSOT module DOES carry them (proof the ratchet is anchored on a real
    // source, not vacuously true).
    const ssot = readSrc("src/mcp/protocol-version.ts")
    expect(ssot).toContain('"2025-11-25"')
    expect(ssot).toContain('"2025-06-18"')
  })
})
