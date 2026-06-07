/**
 * MCP protocol-version negotiation — END-TO-END hellgate (ticket misc-jun-7/01).
 *
 * Unlike the sibling protocol-version tests (which inject a transport instance
 * or pass `protocolVersion` to the transport directly), this drives the FULL
 * REAL seam with NO injected transport:
 *
 *   - a real `McpClient` constructed from a real `McpServerConfig` carrying only
 *     a `url` ⇒ the client builds its OWN real `HttpSseMcpTransport` via the
 *     internal `defaultTransportFor` factory;
 *   - the OFFERED version is resolved through the REAL knob path
 *     `resolveOfferedVersion(runtimeConfig().mcpProtocolMax)` inside the client
 *     constructor — exercised by setting the actual `QUANTA_MCP_PROTOCOL_MAX`
 *     env var + `__resetRuntimeConfig()` (the production seam), NOT by passing a
 *     value in;
 *   - the ONLY boundary stubbed is the network: `globalThis.fetch` (which the
 *     default transport falls back to when no `fetch` is injected). The stub
 *     returns real WHATWG `Response` objects, so the real transport's
 *     `ok/status/headers.get/text()/body` consumption runs unchanged.
 *
 * This proves the gap is closed through the actual loop a wired deployment runs:
 * knob → client constructor → default HTTP transport → `initialize` offer →
 * server reply read → accept/pin → `mcp-protocol-version` header on every
 * subsequent request.
 *
 * Three pillars (per the e2e-hellgate contract):
 *   1. KNOB-ON real-path: an unset knob offers SSOT newest end-to-end; a server
 *      that negotiates down pins the older version and the live header re-pins.
 *   2. DEFAULT-OFF byte-identity: with the knob UNSET, the offered first-
 *      `initialize` value is exactly `LATEST_PROTOCOL_VERSION` and, against a
 *      legacy server that omits `protocolVersion`, the pinned value + every
 *      post-init header are byte-identical to the offered value (no new field /
 *      no drift). The knob pinned to the floor reproduces pre-ticket wire bytes.
 *   3. RED-ON-INJECTION: a server replying with an UNSUPPORTED version makes the
 *      real `start()` throw a typed `McpError` AND tears the live transport down
 *      — removing the fail-closed check (accept-anything) flips the guard.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpError,
  type McpServerConfig,
  PROTOCOL_DOWNGRADE_FLOOR,
} from "@/mcp"
import { __resetRuntimeConfig } from "@/shared"

const ENDPOINT = "https://e2e.example/mcp"

interface PostLog {
  rpcMethod: string | undefined
  protocolHeader: string | undefined
}

/** Build a real WHATWG `Response` carrying a JSON-RPC body, as the server would
 *  answer a POST. We use the real `Response` (not a hand-rolled shape) so the
 *  transport's real `res.ok / res.status / res.headers.get / res.text()`
 *  consumption is exercised unchanged. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const accepted202 = (): Response => new Response("", { status: 202 })

const noServerStream = (): Response => new Response("", { status: 405 })

/**
 * Install a `globalThis.fetch` stub modelling a real MCP HTTP server. It records
 * the `mcp-protocol-version` header on every POST and answers `initialize` with
 * `serverChoice` (omitted entirely when `undefined` ⇒ the legacy shape). Returns
 * a restore fn + the per-POST log. This is the SOLE injection — the client and
 * its transport are otherwise fully real.
 */
const installServer = (serverChoice: string | undefined): { log: PostLog[]; restore: () => void } => {
  const log: PostLog[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const protocolHeader = init.headers["mcp-protocol-version"]
    if (init.method !== "POST") return noServerStream()
    const payload = init.body ? (JSON.parse(init.body) as { method?: string; id?: number }) : {}
    log.push({ rpcMethod: payload.method, protocolHeader })
    if (payload.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          ...(serverChoice !== undefined ? { protocolVersion: serverChoice } : {}),
          capabilities: { tools: {} },
        },
      })
    }
    if (payload.method === "tools/list") {
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } })
    }
    return accepted202()
  }) as unknown as typeof fetch
  return { log, restore: () => { globalThis.fetch = original } }
}

const httpCfg = (): McpServerConfig => ({ name: "e2e-remote", command: [], url: ENDPOINT })

/** Drive the REAL client (no injected transport) end-to-end and return the
 *  first-`initialize` header + the post-init `tools/list` header + the pin. */
const runE2E = async (
  serverChoice: string | undefined,
): Promise<{ log: PostLog[]; pinned: string | null; client: McpClient }> => {
  const { log, restore } = installServer(serverChoice)
  try {
    const client = new McpClient(httpCfg()) // NO transport opt ⇒ builds its own real HttpSseMcpTransport
    await client.start()
    await client.listTools()
    const pinned = client.pinnedProtocolVersion()
    await client.stop()
    return { log, pinned, client }
  } finally {
    restore()
  }
}

beforeEach(() => {
  delete process.env.QUANTA_MCP_PROTOCOL_MAX
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_MCP_PROTOCOL_MAX
  __resetRuntimeConfig()
})

describe("e2e — real client builds its own real HTTP transport, knob-resolved offer", () => {
  test("PILLAR 1 (knob-ON real path): unset knob ⇒ offers SSOT newest; server negotiates DOWN ⇒ pins floor, live header re-pins on subsequent requests", async () => {
    // Server only speaks the floor — the spec-compliant negotiate-down shape.
    const { log, pinned } = await runE2E(PROTOCOL_DOWNGRADE_FLOOR)

    const init = log.find((l) => l.rpcMethod === "initialize")
    const list = log.find((l) => l.rpcMethod === "tools/list")
    // The OFFERED value on the first initialize POST is the SSOT newest — proving
    // the real `resolveOfferedVersion(runtimeConfig().mcpProtocolMax)` → default
    // transport → header chain ran with an unset knob.
    expect(init?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
    // After accepting the server's downgrade, EVERY subsequent request carries the
    // PINNED (server-chosen) value — the gap ("never reads the reply") is closed.
    expect(list?.protocolHeader).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    expect(pinned).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    expect(LATEST_PROTOCOL_VERSION).not.toBe(PROTOCOL_DOWNGRADE_FLOOR) // the change is real
  })

  test("real path: server ACCEPTS the newest offer ⇒ header carries newest throughout", async () => {
    const { log, pinned } = await runE2E(LATEST_PROTOCOL_VERSION)
    const list = log.find((l) => l.rpcMethod === "tools/list")
    expect(list?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
    expect(pinned).toBe(LATEST_PROTOCOL_VERSION)
  })
})

describe("e2e — DEFAULT-OFF byte-identity (PILLAR 2)", () => {
  test("unset knob + legacy server (omits protocolVersion) ⇒ offered=pinned=LATEST and ALL post-init headers byte-identical to the offered value (no new field/drift)", async () => {
    // The legacy server shape: reply has NO protocolVersion (the pre-ticket
    // tolerated case). The wire from the post-initialize point must be identical
    // to the offered value — no new negotiation field leaks onto the header.
    const { log, pinned } = await runE2E(undefined)
    const init = log.find((l) => l.rpcMethod === "initialize")
    const list = log.find((l) => l.rpcMethod === "tools/list")
    expect(init?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION) // offered
    // Legacy-tolerant: pin the offer that connected (NOT a throw, NOT a drift).
    expect(list?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
    expect(pinned).toBe(LATEST_PROTOCOL_VERSION)
    // Every recorded header is exactly the offered value — no per-request drift.
    for (const entry of log) expect(entry.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
  })

  test("knob pinned to the FLOOR ⇒ offered first-initialize value is the pre-ticket constant (byte-identical wire), no re-offer probe", async () => {
    // Operator pins the offered version BACK to the pre-ticket floor via the real
    // env knob. This must reproduce the exact pre-ticket wire: a single initialize
    // offering 2025-06-18, no downgrade probe.
    process.env.QUANTA_MCP_PROTOCOL_MAX = PROTOCOL_DOWNGRADE_FLOOR
    __resetRuntimeConfig()
    // Server is a legacy floor-only server.
    const { log, pinned } = await runE2E(PROTOCOL_DOWNGRADE_FLOOR)
    const inits = log.filter((l) => l.rpcMethod === "initialize")
    // Exactly ONE initialize (no §4.c re-offer probe — we offered the floor).
    expect(inits.length).toBe(1)
    expect(inits[0]?.protocolHeader).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    const list = log.find((l) => l.rpcMethod === "tools/list")
    expect(list?.protocolHeader).toBe(PROTOCOL_DOWNGRADE_FLOOR)
    expect(pinned).toBe(PROTOCOL_DOWNGRADE_FLOOR)
  })

  test("unsupported knob value ⇒ conservative collapse to LATEST (never an unspeakable version on the wire)", async () => {
    process.env.QUANTA_MCP_PROTOCOL_MAX = "1999-01-01" // not in SSOT
    __resetRuntimeConfig()
    const { log } = await runE2E(LATEST_PROTOCOL_VERSION)
    const init = log.find((l) => l.rpcMethod === "initialize")
    // The knob garbage NEVER reaches the wire — resolveOfferedVersion collapses
    // it to LATEST. (No "1999-01-01" anywhere in the offered header.)
    expect(init?.protocolHeader).toBe(LATEST_PROTOCOL_VERSION)
    for (const entry of log) expect(entry.protocolHeader).not.toBe("1999-01-01")
  })
})

describe("e2e — RED-ON-INJECTION: fail-closed on an unsupported server-chosen version (PILLAR 3)", () => {
  test("server replies with an UNSUPPORTED protocolVersion ⇒ real start() throws a typed McpError naming the version + supported set", async () => {
    const { log, restore } = installServer("2030-12-31") // a version we do NOT implement
    try {
      const client = new McpClient(httpCfg())
      let thrown: unknown
      try {
        await client.start()
      } catch (e) {
        thrown = e
      }
      // THE GUARD: an unsupported server-chosen version must fail CLOSED via the
      // real negotiation read in client.start(). If the fail-closed branch were
      // removed (accept-anything), start() would resolve and this assertion flips
      // — that is the red-on-injection contract.
      expect(thrown).toBeInstanceOf(McpError)
      expect((thrown as McpError).message).toContain("2030-12-31")
      expect((thrown as McpError).message).toContain("unsupported protocolVersion")
      // It is a PROTOCOL throw, NOT an isError tool-result (the §3 distinction).
      // initialize WAS sent (negotiation read happened post-reply), proving the
      // throw is from the read, not a pre-flight rejection.
      expect(log.some((l) => l.rpcMethod === "initialize")).toBe(true)
      // And it never silently proceeded to tools/list on the bad version.
      expect(log.some((l) => l.rpcMethod === "tools/list")).toBe(false)
    } finally {
      restore()
    }
  })

  test("fail-closed start() tears the live transport down — client lands in a terminal stopped state with NO leaked live carrier", async () => {
    // First connect: unsupported version ⇒ fail closed.
    const bad = installServer("2030-12-31")
    const client = new McpClient(httpCfg())
    try {
      await expect(client.start()).rejects.toBeInstanceOf(McpError)

      // The R1 fail-closed teardown ran `stop()` INSIDE start(): the carrier is
      // closed and the client is terminally stopped. Honest behaviour of the
      // in-process client (verified against client.ts:869 stop / :895 ensureReady):
      // it does NOT auto-retry — that terminal state is the correct fix for the R4
      // supervisor crash-loop (never silently reconnect to a server that fails
      // closed every time). Prove there is no LEAKED live carrier:
      //   (a) any post-fail operation throws "not running" (ensureReady), i.e. the
      //       carrier is not left usable; and
      //   (b) the pinned version is null (never pinned the unsupported version).
      await expect(client.listTools()).rejects.toBeInstanceOf(McpError)
      expect(client.pinnedProtocolVersion()).toBeNull()
      // A second start() is a no-op early-return (terminal stopped state) — it must
      // NOT silently re-open a transport against the still-installed bad server.
      const logLenBefore = bad.log.length
      await client.start()
      expect(bad.log.length).toBe(logLenBefore) // no new initialize POST issued
      // stop() is idempotent — calling it again does not throw or double-close.
      await client.stop()
    } finally {
      bad.restore()
    }
  })
})
