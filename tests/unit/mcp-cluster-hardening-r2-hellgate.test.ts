/** MCP CLUSTER hardening — Round 2 adversarial hellgate.
 *
 *  Seals the three RESIDUAL risks Round 1 flagged but did not fully close. Every
 *  test uses fakes (no real network / browser / keyring). The attack matrix:
 *
 *    (1) isUnauthorizedError textual OVER-MATCH: a JSON-RPC error whose message
 *        merely CONTAINS "401"/"unauthorized" — but is NOT a transport HTTP-401 —
 *        MUST NOT trigger a re-auth. Only the transport's structured `HTTP 401`
 *        status marker re-auths. Proven both at the predicate level (unit) and
 *        end-to-end through a live OAuth client (no invalidate / no re-ask).
 *
 *    (2) reauthInFlight CONCURRENCY: two concurrent requests that BOTH 401 must
 *        coalesce into EXACTLY ONE carrier rebuild (re-authorize count === 1),
 *        and both requests succeed after the single rebuild.
 *
 *    (3) resources/read blob/text NOT size-capped: a server returning an
 *        arbitrarily large `blob`/`text` is refused with a typed `too-large`
 *        failure (no unbounded allocation), while a sub-cap payload is returned
 *        intact (byte-identical — default-OFF discipline preserved).
 */

import { describe, expect, it } from "bun:test"
import { McpClient, type McpOAuthProviderPort, type McpServerConfig } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import {
  type CappedResourceRead,
  parseResourceRead,
  parseResourceReadCapped,
  RESOURCE_READ_MAX_CONTENT_CHARS,
  resourceContentChars,
} from "@/mcp/resources/codec"
import type { McpTransport } from "@/mcp/transports/port"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 128; i++) await Promise.resolve()
}

// ─────────────────────────────────────────────────────────────────────────────
// A scripted transport that records sent payloads + the effective bearer, and
// can be told (per-method) to reply with a chosen JSON-RPC error envelope. Used
// to drive the live re-auth path with EXACT control over the error message.
// ─────────────────────────────────────────────────────────────────────────────

interface Sent {
  readonly method: string | undefined
  readonly bearer: string
}

/** Build a transport whose `tools/list` reply is controlled by `replyFor`:
 *  returning a `{ error }` envelope rejects the request with that message;
 *  returning `null` answers success. `initialize` always succeeds so a re-auth
 *  rebuild always re-handshakes cleanly (the 401, if any, stays isolated to the
 *  steady-state request). */
const makeReplyTransport = (
  headers: () => Record<string, string>,
  replyFor: (bearer: string) => { error: { code: number; message: string } } | null,
) => {
  let onMsg: ((m: JsonRpcMessage) => void) | null = null
  const sent: Sent[] = []
  const transport: McpTransport = {
    async start() {},
    onMessage(h) {
      onMsg = h
      return () => {
        onMsg = null
      }
    },
    onExit() {
      return () => {}
    },
    send(payload) {
      const p = payload as Record<string, unknown>
      const id = p.id
      const method = typeof p.method === "string" ? p.method : undefined
      const bearer = (headers().Authorization ?? "").replace(/^Bearer /, "")
      if (typeof id !== "number") return null // notification
      sent.push({ method, bearer })
      if (method === "initialize") {
        queueMicrotask(() =>
          onMsg?.({ jsonrpc: "2.0", id, result: { capabilities: {} } } as JsonRpcMessage),
        )
        return null
      }
      const reply = method === "tools/list" ? replyFor(bearer) : null
      if (reply !== null) {
        queueMicrotask(() => onMsg?.({ jsonrpc: "2.0", id, ...reply } as JsonRpcMessage))
        return null
      }
      queueMicrotask(() => onMsg?.({ jsonrpc: "2.0", id, result: { tools: [] } } as JsonRpcMessage))
      return null
    },
    async close() {},
  }
  return { transport, sent }
}

const httpConfig = (): McpServerConfig => ({
  name: "remote",
  command: [],
  url: "https://mcp.example.com/rpc",
  oauth: true,
})

// ═════════════════════════════════════════════════════════════════════════════
// (1) isUnauthorizedError OVER-MATCH — only a structured transport HTTP-401
//     re-auths; a bare "401"/"unauthorized" substring NEVER does.
// ═════════════════════════════════════════════════════════════════════════════

describe("R2 #1 — re-auth fires ONLY on a structured HTTP 401, never on text", () => {
  /** Spin up a live OAuth client whose `tools/list` ALWAYS replies with `error`,
   *  and observe whether the re-auth path (provider.invalidate / tokenFor) was
   *  entered. Returns the provider counters + whether the call rejected. */
  const runWithErrorReply = async (error: {
    code: number
    message: string
  }): Promise<{ invals: number; asks: number; rejected: boolean }> => {
    let asks = 0
    let invals = 0
    const provider: McpOAuthProviderPort = {
      tokenFor: async () => {
        asks += 1
        return `TOK-${asks}`
      },
      invalidate: async () => {
        invals += 1
      },
    }
    let headers: Record<string, string> = {}
    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      transport: (cfg) => {
        headers = cfg.headers ?? {}
        return makeReplyTransport(
          () => headers,
          () => ({ error }),
        ).transport
      },
    })
    await client.start() // initialize succeeds (asks === 1)
    let rejected = false
    await client.listTools().catch(() => {
      rejected = true
    })
    await client.stop()
    return { invals, asks, rejected }
  }

  it("(1a) a server error mentioning '401' in a PATH ⇒ NO re-auth (surfaced as-is)", async () => {
    const r = await runWithErrorReply({
      code: -32000,
      message: "internal: file /var/log/access-401.txt not found",
    })
    expect(r.rejected).toBe(true) // the error surfaces…
    expect(r.invals).toBe(0) // …but re-auth was NEVER entered
    expect(r.asks).toBe(1) // only the start bearer was resolved
  })

  it("(1b) an application-level 'unauthorized' error ⇒ NO re-auth (not an HTTP 401)", async () => {
    const r = await runWithErrorReply({
      code: -32603,
      message: "tool refused: caller is unauthorized to access /admin",
    })
    expect(r.rejected).toBe(true)
    expect(r.invals).toBe(0)
    expect(r.asks).toBe(1)
  })

  it("(1c) a bare line/version number like '401' WITHOUT 'HTTP' ⇒ NO re-auth", async () => {
    const r = await runWithErrorReply({
      code: -32000,
      message: "parse error at line 401, column 7",
    })
    expect(r.rejected).toBe(true)
    expect(r.invals).toBe(0)
    expect(r.asks).toBe(1)
  })

  it("(1d) 'HTTP 4012' / 'HTTP 401x' (word-bounded) ⇒ NOT treated as 401", async () => {
    const r = await runWithErrorReply({
      code: -32000,
      message: "transport POST failed: HTTP 4012 weird",
    })
    expect(r.rejected).toBe(true)
    expect(r.invals).toBe(0)
    expect(r.asks).toBe(1)
  })

  it("(1e) a 403/500 ⇒ NO re-auth (only 401 is auth-stale)", async () => {
    const r403 = await runWithErrorReply({
      code: -32000,
      message: "transport POST failed: HTTP 403",
    })
    expect(r403.invals).toBe(0)
    const r500 = await runWithErrorReply({
      code: -32000,
      message: "transport POST failed: HTTP 500",
    })
    expect(r500.invals).toBe(0)
  })

  it("(1f) the GENUINE transport 'HTTP 401' marker ⇒ re-auth fires EXACTLY once", async () => {
    // Control: the structured marker MUST still drive the recovery path. The
    // provider always re-mints a token the server also rejects, so the retry is
    // bounded to one re-auth (proving #1 didn't break the real path).
    const r = await runWithErrorReply({
      code: -32000,
      message: "transport POST failed: HTTP 401",
    })
    expect(r.rejected).toBe(true)
    expect(r.invals).toBe(1) // re-auth WAS entered…
    expect(r.asks).toBe(2) // …exactly once (start + one re-auth), no loop
  })

  it("(1g) the mixed-case 'http 401' marker still matches (case-insensitive on HTTP)", async () => {
    const r = await runWithErrorReply({
      code: -32000,
      message: "transport POST failed: http 401 unauthorized",
    })
    expect(r.invals).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (2) reauthInFlight CONCURRENCY — two concurrent 401s rebuild the carrier
//     EXACTLY ONCE (shared-promise coalescing), both requests succeed after.
// ═════════════════════════════════════════════════════════════════════════════

describe("R2 #2 — concurrent 401s coalesce into a SINGLE carrier rebuild", () => {
  it("(2) listTools() + a second tools/list both 401 ⇒ ONE re-authorize, both succeed", async () => {
    // STALE first, FRESH after the (single) invalidate. We count invalidate +
    // tokenFor + how many times the transport FACTORY runs (== carrier rebuilds).
    let asks = 0
    let invals = 0
    const provider: McpOAuthProviderPort = {
      tokenFor: async () => {
        asks += 1
        // Resolve on a later microtask so two concurrent re-auths would race the
        // shared-promise guard if it were not coalescing.
        await flush()
        return invals === 0 ? "STALE" : "FRESH"
      },
      invalidate: async () => {
        invals += 1
        await flush()
      },
    }

    const staleSet = new Set<string>(["STALE"])
    let headers: Record<string, string> = {}
    let factoryRuns = 0
    let toolsListSends = 0

    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      transport: (cfg) => {
        factoryRuns += 1
        headers = cfg.headers ?? {}
        const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "")
        if (bearer === "FRESH") staleSet.delete("STALE")
        return makeReplyTransport(
          () => headers,
          (b) => {
            // `initialize` is handled inside makeReplyTransport; this is the
            // tools/list gate: 401 iff the current bearer is stale.
            toolsListSends += 1
            return staleSet.has(b)
              ? { error: { code: -32000, message: "transport POST failed: HTTP 401" } }
              : null
          },
        ).transport
      },
    })

    await client.start() // initialize with STALE succeeds (factoryRuns === 1)
    expect(factoryRuns).toBe(1)

    // Fire TWO concurrent tools/list. Both observe STALE → both 401 → both enter
    // request()'s catch → both call reauthorize(). The shared in-flight promise
    // MUST coalesce these into a single invalidate + single carrier rebuild.
    const [a, b] = await Promise.all([client.listTools(), client.listTools()])

    expect(a).toEqual([]) // both succeed on the rebuilt FRESH carrier
    expect(b).toEqual([])
    expect(invals).toBe(1) // EXACTLY ONE re-auth (not one-per-401)
    // asks: 1 (start) + 1 (single shared re-auth) = 2. A non-coalesced path would
    // invalidate/re-ask twice.
    expect(asks).toBe(2)
    // Carrier rebuilt exactly once: factory ran at start + once on the shared
    // re-auth = 2. A per-401 rebuild would be 3.
    expect(factoryRuns).toBe(2)
    expect(toolsListSends).toBeGreaterThanOrEqual(2)

    await client.stop()
  })

  it("(2b) the re-auth guard RESETS after completion (a later 401 can re-auth again)", async () => {
    // Proves reauthInFlight is cleared in `finally` — a fresh 401 in a NEW window
    // must be able to start its own rebuild, not be wedged by the prior one. Each
    // invalidate hands back the NEXT token, which is always accepted, so every
    // window re-auths exactly once and succeeds.
    let invals = 0
    // index 0 = the start bearer (STALE), each invalidate advances to the next.
    const tokens = ["STALE", "FRESH-1", "FRESH-2"]
    let idx = 0
    const provider: McpOAuthProviderPort = {
      tokenFor: async () => tokens[Math.min(idx, tokens.length - 1)] ?? "FRESH",
      invalidate: async () => {
        invals += 1
        idx += 1
      },
    }
    // Only the bearer currently marked stale 401s. We flip the active bearer
    // stale between the two windows to force a SECOND, independent re-auth.
    const stale = new Set<string>(["STALE"])
    let headers: Record<string, string> = {}
    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      transport: (cfg) => {
        headers = cfg.headers ?? {}
        return makeReplyTransport(
          () => headers,
          (b) =>
            stale.has(b)
              ? { error: { code: -32000, message: "transport POST failed: HTTP 401" } }
              : null,
        ).transport
      },
    })
    await client.start() // bearer STALE
    await client.listTools() // STALE 401 → re-auth → FRESH-1 ok (inval 1)
    expect(invals).toBe(1)
    // A later mid-session revocation: the currently-live FRESH-1 bearer goes stale.
    stale.add("FRESH-1")
    await client.listTools() // FRESH-1 401 → re-auth AGAIN → FRESH-2 ok (inval 2)
    expect(invals).toBe(2) // guard reset allowed a 2nd independent re-auth
    await client.stop()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (3) resources/read size cap — oversized blob/text ⇒ typed `too-large`, no
//     unbounded allocation; sub-cap payload returned intact (byte-identical).
// ═════════════════════════════════════════════════════════════════════════════

describe("R2 #3 — resources/read content is byte-capped (typed too-large)", () => {
  it("(3a) parseResourceReadCapped: an over-cap blob ⇒ {kind:'too-large'}, no throw", () => {
    // A single blob ONE char over the cap. We build the string with repeat
    // (cheap) — the point is the codec REFUSES rather than retaining it.
    const oversized = "A".repeat(RESOURCE_READ_MAX_CONTENT_CHARS + 1)
    const res: CappedResourceRead = parseResourceReadCapped({
      contents: [{ uri: "file:///huge", blob: oversized }],
    })
    expect(res.kind).toBe("too-large")
    if (res.kind === "too-large") {
      expect(res.chars).toBe(RESOURCE_READ_MAX_CONTENT_CHARS + 1)
    }
  })

  it("(3b) cumulative text+blob across MANY blocks trips the cap (not just one block)", () => {
    // Each block is under cap, but the SUM exceeds it — the cap is cumulative.
    const half = Math.floor(RESOURCE_READ_MAX_CONTENT_CHARS / 2) + 10
    const res = parseResourceReadCapped({
      contents: [
        { uri: "file:///a", text: "A".repeat(half) },
        { uri: "file:///b", blob: "B".repeat(half) },
      ],
    })
    expect(res.kind).toBe("too-large")
  })

  it("(3c) a payload EXACTLY at the cap is allowed (boundary: cap is inclusive)", () => {
    const atCap = "A".repeat(RESOURCE_READ_MAX_CONTENT_CHARS)
    const res = parseResourceReadCapped({
      contents: [{ uri: "file:///edge", blob: atCap }],
    })
    expect(res.kind).toBe("ok")
    if (res.kind === "ok") {
      expect(res.contents[0]?.blob?.length).toBe(RESOURCE_READ_MAX_CONTENT_CHARS)
    }
  })

  it("(3d) a normal sub-cap blob is returned INTACT (R1 (e) byte-identity preserved)", () => {
    const bigBlob = "QUFB".repeat(1_000_000) // ~4MB — well under the 96MiB cap
    const res = parseResourceReadCapped({
      contents: [{ uri: "file:///big", mimeType: "application/octet-stream", blob: bigBlob }],
    })
    expect(res.kind).toBe("ok")
    if (res.kind === "ok") {
      expect(res.contents.length).toBe(1)
      expect(res.contents[0]?.blob?.length).toBe(bigBlob.length) // intact, not truncated
      expect(res.contents[0]?.uri).toBe("file:///big")
    }
  })

  it("(3e) malformed (contents not an array) ⇒ {kind:'malformed'}, distinct from too-large", () => {
    expect(parseResourceReadCapped({ contents: "nope" }).kind).toBe("malformed")
    expect(parseResourceReadCapped(null).kind).toBe("malformed")
    expect(parseResourceReadCapped([]).kind).toBe("malformed")
  })

  it("(3f) resourceContentChars sums text+blob and ignores absent fields", () => {
    const parsed = parseResourceRead({
      contents: [
        { uri: "file:///t", text: "hello" }, // 5
        { uri: "file:///b", blob: "AAAA" }, // 4
        { uri: "file:///e" }, // 0 (neither)
      ],
    })
    expect(parsed).not.toBeNull()
    expect(resourceContentChars(parsed ?? [])).toBe(9)
  })

  it("(3g) client.readResource surfaces a typed 'too-large' failure end-to-end", async () => {
    // Drive the live client read path: advertise resources, then return an
    // over-cap blob. The result MUST be the typed too-large failure — not a
    // throw, not malformed, not an unbounded value flowing to the caller.
    let onMsg: ((m: JsonRpcMessage) => void) | null = null
    const transport: McpTransport = {
      async start() {},
      onMessage(h) {
        onMsg = h
        return () => {
          onMsg = null
        }
      },
      onExit() {
        return () => {}
      },
      send(payload) {
        const p = payload as Record<string, unknown>
        const id = p.id
        if (typeof id !== "number") return null
        if (p.method === "initialize") {
          queueMicrotask(() =>
            onMsg?.({
              jsonrpc: "2.0",
              id,
              result: { capabilities: { resources: {} } },
            } as JsonRpcMessage),
          )
        } else if (p.method === "resources/read") {
          const oversized = "Z".repeat(RESOURCE_READ_MAX_CONTENT_CHARS + 5)
          queueMicrotask(() =>
            onMsg?.({
              jsonrpc: "2.0",
              id,
              result: { contents: [{ uri: "file:///evil", blob: oversized }] },
            } as JsonRpcMessage),
          )
        }
        return null
      },
      async close() {},
    }
    const client = new McpClient({ name: "srv", command: ["x"] }, { transport })
    await client.start()
    const res = await client.readResource("file:///evil")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("too-large")
      expect(res.message).toContain("exceeds")
    }
    await client.stop()
  })

  it("(3h) client.readResource returns a normal sub-cap resource intact", async () => {
    let onMsg: ((m: JsonRpcMessage) => void) | null = null
    const transport: McpTransport = {
      async start() {},
      onMessage(h) {
        onMsg = h
        return () => {
          onMsg = null
        }
      },
      onExit() {
        return () => {}
      },
      send(payload) {
        const p = payload as Record<string, unknown>
        const id = p.id
        if (typeof id !== "number") return null
        if (p.method === "initialize") {
          queueMicrotask(() =>
            onMsg?.({
              jsonrpc: "2.0",
              id,
              result: { capabilities: { resources: {} } },
            } as JsonRpcMessage),
          )
        } else if (p.method === "resources/read") {
          queueMicrotask(() =>
            onMsg?.({
              jsonrpc: "2.0",
              id,
              result: { contents: [{ uri: "file:///ok", text: "small body" }] },
            } as JsonRpcMessage),
          )
        }
        return null
      },
      async close() {},
    }
    const client = new McpClient({ name: "srv", command: ["x"] }, { transport })
    await client.start()
    const res = await client.readResource("file:///ok")
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toEqual([{ uri: "file:///ok", text: "small body" }])
    }
    await client.stop()
  })
})
