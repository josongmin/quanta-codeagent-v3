/** H18 — MCP OAuth end-to-end hellgate (write FIRST: red → green).
 *
 *  Drives a REAL `McpClient` over a fake in-memory transport with the OAuth
 *  PORT wired, proving the full 401 → discovery → authorize → authed-request
 *  cycle end to end:
 *    (1) knob/opt-in ON + provider wired ⇒ the client resolves a bearer BEFORE
 *        `start()` and the transport sees `Authorization: Bearer <token>`;
 *    (2) the bearer is attached to EVERY subsequent request (initialize,
 *        tools/list, tools/call) — not just the first;
 *    (3) opt-in OFF (no provider) ⇒ the transport sees NO Authorization header
 *        (byte-identical to the pre-H18 client);
 *    (4) a server reply still routes through the normal request core (the
 *        OAuth seam does not perturb dispatch/timeout);
 *    (5) a 401 MID-SESSION (the server revokes the bearer after `start()`) ⇒ the
 *        client invalidates the stored token, re-resolves a fresh bearer via the
 *        provider, rebuilds the transport with the new `Authorization` header,
 *        and retries the SAME request ONCE — transparently to the caller.
 */

import { describe, expect, it } from "bun:test"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "@/mcp"
import { McpClient, type McpOAuthProviderPort, type McpServerConfig } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"

// ── a fake transport that auto-answers initialize + records sent payloads ────

interface SentRecord {
  readonly payload: Record<string, unknown>
  readonly authHeader: string | undefined
}

/** A fake MCP transport built from a per-server header set (the client injects
 *  the resolved bearer into `config.headers` before constructing it). It
 *  auto-replies to `initialize` and `tools/list`, and records every payload +
 *  the Authorization header in effect at send time. */
const fakeTransportFactory = (headers: () => Record<string, string>) => {
  const sent: SentRecord[] = []
  let onMsg: McpTransportMessageHandler | null = null
  const transport: McpTransport = {
    async start() {},
    onMessage(h: McpTransportMessageHandler) {
      onMsg = h
      return () => {
        onMsg = null
      }
    },
    onExit(_h: McpTransportExitHandler) {
      return () => {}
    },
    send(payload: McpTransportPayload): Error | null {
      const p = payload as Record<string, unknown>
      sent.push({ payload: p, authHeader: headers().Authorization })
      // Auto-answer requests (those with an id) so the client's pending core
      // resolves. Notifications (no id) need no reply.
      const id = p.id
      if (typeof id === "number") {
        const method = p.method
        const result =
          method === "initialize"
            ? { capabilities: {}, serverInfo: { name: "fake", version: "0" } }
            : method === "tools/list"
              ? { tools: [{ name: "echo", description: "", inputSchema: { type: "object" } }] }
              : method === "tools/call"
                ? { content: [{ type: "text", text: "ok" }] }
                : {}
        queueMicrotask(() => onMsg?.({ jsonrpc: "2.0", id, result } as JsonRpcMessage))
      }
      return null
    },
    async close() {},
  }
  return { transport, sent: () => sent }
}

/** A provider that hands back a fixed bearer (records how many times asked). */
const stubProvider = (token: string): McpOAuthProviderPort & { asks: () => number } => {
  let n = 0
  return {
    asks: () => n,
    tokenFor: async () => {
      n += 1
      return token
    },
    invalidate: async () => {},
  }
}

const httpConfig = (): McpServerConfig => ({
  name: "remote",
  command: [],
  url: "https://mcp.example.com/rpc",
  oauth: true,
})

// ── tests ───────────────────────────────────────────────────────────────────

describe("mcp-oauth e2e — bearer attached to every request", () => {
  it("opt-in ON + provider ⇒ Authorization: Bearer on initialize + tools/list + tools/call", async () => {
    let injectedHeaders: Record<string, string> = {}
    const { transport, sent } = fakeTransportFactory(() => injectedHeaders)
    const provider = stubProvider("TKN-123")

    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      // The client resolves the bearer and exposes the resulting headers to the
      // transport factory; we mirror them into `injectedHeaders` so the fake can
      // report the header in effect (the real HTTP transport merges static
      // headers identically).
      transport: (cfg) => {
        injectedHeaders = cfg.headers ?? {}
        return transport
      },
    })

    await client.start()
    await client.listTools()
    await client.callTool("echo", {})

    expect(provider.asks()).toBeGreaterThanOrEqual(1)
    const records = sent()
    expect(records.length).toBeGreaterThanOrEqual(3)
    for (const r of records) {
      if ((r.payload.method as string)?.startsWith("notifications/")) continue
      expect(r.authHeader).toBe("Bearer TKN-123")
    }
  })

  it("opt-in OFF (no oauth flag) ⇒ no Authorization header (byte-identical)", async () => {
    let injectedHeaders: Record<string, string> = {}
    const { transport, sent } = fakeTransportFactory(() => injectedHeaders)
    const provider = stubProvider("SHOULD-NOT-BE-USED")

    const cfg: McpServerConfig = {
      name: "remote",
      command: [],
      url: "https://mcp.example.com/rpc",
      // no `oauth: true`
    }
    const client = new McpClient(cfg, {
      oauthProvider: provider,
      transport: (c) => {
        injectedHeaders = c.headers ?? {}
        return transport
      },
    })

    await client.start()
    await client.listTools()

    expect(provider.asks()).toBe(0) // provider never consulted
    for (const r of sent()) {
      expect(r.authHeader).toBeUndefined()
    }
  })

  it("opt-in ON but NO provider wired ⇒ no Authorization header (no flow)", async () => {
    let injectedHeaders: Record<string, string> = {}
    const { transport, sent } = fakeTransportFactory(() => injectedHeaders)

    const client = new McpClient(httpConfig(), {
      transport: (c) => {
        injectedHeaders = c.headers ?? {}
        return transport
      },
    })

    await client.start()
    expect(sent().every((r) => r.authHeader === undefined)).toBe(true)
  })
})

// ── a fake transport that 401s any request bearing a stale token ──────────────

/** A rotating provider: hands back `STALE` first, then `FRESH` after the client
 *  invalidates. Records every `invalidate` and `tokenFor` call. */
const rotatingProvider = (): McpOAuthProviderPort & {
  asks: () => number
  invalidations: () => number
} => {
  let asks = 0
  let invalidations = 0
  const tokens = ["STALE", "FRESH"]
  return {
    asks: () => asks,
    invalidations: () => invalidations,
    tokenFor: async () => {
      const t = tokens[Math.min(asks, tokens.length - 1)] as string
      asks += 1
      return t
    },
    invalidate: async () => {
      invalidations += 1
    },
  }
}

/** A fake transport that REJECTS (mid-session 401) any request whose effective
 *  `Authorization` header carries a token in `staleTokens`, replying with a
 *  JSON-RPC error whose message carries the HTTP status (mirroring the real
 *  HTTP-SSE carrier's `transport POST failed: HTTP 401`). Requests bearing a
 *  non-stale bearer succeed. Records every send + the header in effect. */
const fake401Transport = (headers: () => Record<string, string>, staleTokens: Set<string>) => {
  const sent: SentRecord[] = []
  let onMsg: McpTransportMessageHandler | null = null
  const transport: McpTransport = {
    async start() {},
    onMessage(h: McpTransportMessageHandler) {
      onMsg = h
      return () => {
        onMsg = null
      }
    },
    onExit(_h: McpTransportExitHandler) {
      return () => {}
    },
    send(payload: McpTransportPayload): Error | null {
      const p = payload as Record<string, unknown>
      const auth = headers().Authorization
      sent.push({ payload: p, authHeader: auth })
      const id = p.id
      if (typeof id !== "number") return null
      const bearer = (auth ?? "").replace(/^Bearer /, "")
      if (staleTokens.has(bearer)) {
        // The server rejects the stale bearer mid-session with an HTTP-401-shaped
        // JSON-RPC error (the same envelope the real carrier emits on a non-2xx).
        queueMicrotask(() =>
          onMsg?.({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "transport POST failed: HTTP 401" },
          } as JsonRpcMessage),
        )
        return null
      }
      const method = p.method
      const result =
        method === "initialize"
          ? { capabilities: {}, serverInfo: { name: "fake", version: "0" } }
          : method === "tools/list"
            ? { tools: [{ name: "echo", description: "", inputSchema: { type: "object" } }] }
            : {}
      queueMicrotask(() => onMsg?.({ jsonrpc: "2.0", id, result } as JsonRpcMessage))
      return null
    },
    async close() {},
  }
  return { transport, sent: () => sent }
}

describe("mcp-oauth e2e — 401 mid-session re-auth + retry", () => {
  it("a 401 after start ⇒ invalidate + fresh bearer + transport rebuilt + retried once", async () => {
    const provider = rotatingProvider()
    // `STALE` is the first token; `initialize` succeeds (the IdP issues STALE),
    // but the server then revokes it, so the next request 401s. The client must
    // invalidate, re-resolve `FRESH`, rebuild, and retry.
    const staleTokens = new Set<string>(["STALE"])
    let currentHeaders: Record<string, string> = {}
    let buildCount = 0

    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      transport: (cfg) => {
        buildCount += 1
        currentHeaders = cfg.headers ?? {}
        // After the first rebuild the client re-resolves a FRESH bearer; once
        // FRESH is in the header, drop STALE from the reject set so the retry
        // (and `initialize` on the rebuilt carrier) succeed.
        if ((currentHeaders.Authorization ?? "").includes("FRESH")) staleTokens.delete("STALE")
        return fake401Transport(() => currentHeaders, staleTokens).transport
      },
    })

    await client.start() // initialize with STALE succeeds
    // First tools/list goes out with STALE → server 401s → client re-auths +
    // retries with FRESH → resolves to the tool list (no throw to the caller).
    const tools = await client.listTools()

    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(provider.invalidations()).toBeGreaterThanOrEqual(1) // stale token forgotten
    expect(provider.asks()).toBeGreaterThanOrEqual(2) // FRESH re-resolved
    expect(buildCount).toBeGreaterThanOrEqual(2) // transport rebuilt with new bearer
    expect(currentHeaders.Authorization).toBe("Bearer FRESH")
  })

  it("a 401 with NO oauth (opt-in OFF) ⇒ surfaced as a normal error (no retry)", async () => {
    const staleTokens = new Set<string>([""]) // empty bearer (no auth) is 'stale'
    const { transport } = fake401Transport(() => ({}), staleTokens)
    const cfg: McpServerConfig = {
      name: "remote",
      command: [],
      url: "https://mcp.example.com/rpc",
      // no oauth flag ⇒ no re-auth path; a 401 is a plain transport error.
    }
    const client = new McpClient(cfg, { transport: () => transport })
    await client.start().catch(() => {})
    // initialize itself 401s (empty bearer is stale) and the client surfaces it
    // as an ordinary McpError — never entering the OAuth retry path.
    await expect(client.listTools()).rejects.toThrow()
  })
})
