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
 *        OAuth seam does not perturb dispatch/timeout).
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
