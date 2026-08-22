/** MCP CLUSTER hardening — Round 1 adversarial hellgate (jun-04: B1 sampling,
 *  H18 OAuth, H19 resources/prompts/roots, supervised reconnect).
 *
 *  This battery attacks the cluster's hostile-MCP-server surface with cases NOT
 *  already sealed by the per-feature suites. Every test uses fakes (no real
 *  network / browser / keyring). The attack matrix (from the R1 brief):
 *
 *    (a) capability-spoof: advertise `resources`/`prompts`, then return garbage
 *        ⇒ typed `malformed`, never a throw, no token/blob crash.
 *    (b) sampling OFF / headless: an unsolicited `sampling/createMessage` ⇒ a
 *        typed JSON-RPC decline (`no-handler`), the LLM is NEVER called, no throw.
 *    (c) token-no-leak via LOG capture: a refresh-fail → re-auth path logs
 *        diagnostics but NEVER the bearer/refresh token (stderr capture).
 *    (d) 401 LOOP: a server that 401s EVEN with the freshly-resolved bearer ⇒ the
 *        client retries EXACTLY ONCE then surfaces the error (bounded, no loop).
 *    (e) huge blob: `resources/read` with a multi-MB base64 blob ⇒ parsed intact,
 *        no throw, no truncation.
 *    (f) UNKNOWN inbound method ⇒ raw `-32601`; recognized-but-UNADVERTISED
 *        outbound method ⇒ typed `unsupported` with NO request emitted on the wire.
 *    (g) reconnect: after an OAuth carrier-rebuild the inbound sampling handler +
 *        roots provider STILL answer (the re-auth rebuild re-wires dispatch).
 *    (h) a consent prompter that THROWS ⇒ `user-denied`, LLM NEVER called.
 */

import { describe, expect, it } from "bun:test"
import type {
  ClockPort,
  FetchPort,
  FetchPortResponse,
  TokenRecord,
  TokenStorePort,
} from "@/connectors"
import { createConnectorsMcpOAuthProvider } from "@/host/runtime/mcp-oauth-provider"
import { createLlmSamplingHandler } from "@/host/runtime/mcp-sampling-handler"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  type ElicitationPrompter,
  type ElicitationResult,
  McpClient,
  type McpOAuthProviderPort,
  type McpServerConfig,
  type RootsProviderPort,
  type SamplingHandlerPort,
} from "@/mcp"
import { fullNegotiator } from "@/mcp/capabilities"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { isRootsMethod, MCP_ROOTS_LIST_METHOD, routeRootsList } from "@/mcp/resources"
import { parseResourceRead } from "@/mcp/resources/codec"
import { isSamplingMethod, MCP_SAMPLING_METHOD, routeSampling } from "@/mcp/sampling"
import type { McpTransport } from "@/mcp/transports/port"

// ─────────────────────────────────────────────────────────────────────────────
// Shared scripted transport: records every sent payload (with the effective
// Authorization header), lets the test emit inbound messages, and can be told to
// auto-answer initialize/tools/list.
// ─────────────────────────────────────────────────────────────────────────────

const flush = async (): Promise<void> => {
  for (let i = 0; i < 128; i++) await Promise.resolve()
}

interface Sent {
  readonly payload: Record<string, unknown>
  readonly auth: string | undefined
}

class ScriptedTransport implements McpTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Sent[] = []
  private readonly headers: () => Record<string, string>
  /** When set, the transport never auto-answers; the test drives every reply. */
  private readonly manual: boolean
  /** Server capability record echoed on `initialize`. */
  serverCaps: Record<string, unknown> = {}

  constructor(opts?: { headers?: () => Record<string, string>; manual?: boolean }) {
    this.headers = opts?.headers ?? (() => ({}))
    this.manual = opts?.manual ?? false
  }
  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const p = payload as Record<string, unknown>
    this.sent.push({ payload: p, auth: this.headers().Authorization })
    if (!this.manual && typeof p.id === "number") {
      const m = p.method
      if (m === "initialize") {
        this.emit({ jsonrpc: "2.0", id: p.id as number, result: { capabilities: this.serverCaps } })
      } else if (m === "tools/list") {
        this.emit({ jsonrpc: "2.0", id: p.id as number, result: { tools: [] } })
      }
    }
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.handler?.(msg)
  }
  /** The methods that were sent OUTBOUND (client→server) on the wire. */
  outboundMethods(): string[] {
    return this.sent.map((s) => s.payload.method).filter((m): m is string => typeof m === "string")
  }
  /** The last payload the client sent (its reply to an inbound request). */
  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1]?.payload ?? {}
  }
}

const fakeLlm = (): { llm: LLMPort; calls: () => number } => {
  let n = 0
  return {
    calls: () => n,
    llm: {
      model: "fake",
      stream(_in: StreamInput): AsyncIterable<StreamEvent> {
        n += 1
        return (async function* () {
          yield { type: "text_delta", delta: "ok" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        })()
      },
    },
  }
}

const consentOf = (answer: ElicitationResult<boolean>): ElicitationPrompter => {
  const reject = async (): Promise<never> => {
    throw new Error("only promptBoolean")
  }
  return {
    promptBoolean: async () => answer,
    promptString: reject,
    promptNumber: reject,
    promptInteger: reject,
    promptEnum: reject,
    promptMultiEnum: reject,
    promptSingleEnum: reject,
    promptUrl: reject,
  }
}

/** A consent prompter whose promptBoolean THROWS (attack: a buggy/hostile UI). */
const throwingConsent = (): ElicitationPrompter => {
  const reject = async (): Promise<never> => {
    throw new Error("boom")
  }
  return {
    promptBoolean: reject,
    promptString: reject,
    promptNumber: reject,
    promptInteger: reject,
    promptEnum: reject,
    promptMultiEnum: reject,
    promptSingleEnum: reject,
    promptUrl: reject,
  }
}

const SAMPLE = {
  messages: [{ role: "user", content: { type: "text", text: "hi" } }],
}

/** Spin up a real McpClient over a scripted transport, complete the handshake. */
const startClient = async (
  config: McpServerConfig,
  opts: ConstructorParameters<typeof McpClient>[1],
  transport: ScriptedTransport,
): Promise<McpClient> => {
  const client = new McpClient(config, { ...opts, transport })
  await client.start()
  return client
}

const CONFIG: McpServerConfig = { name: "srv", command: ["x"] }

// ═════════════════════════════════════════════════════════════════════════════
// (b) + (h) — inbound sampling: OFF/headless declines, throwing consent denies,
//             malformed garbage params decline, all without calling the LLM.
// ═════════════════════════════════════════════════════════════════════════════

describe("B1 sampling — hostile inbound (decline, no LLM, no throw)", () => {
  it("(b1) headless rejecter (default) ⇒ JSON-RPC decline `no-handler`, no throw", async () => {
    const t = new ScriptedTransport()
    const client = await startClient(CONFIG, {}, t)
    t.emit({ jsonrpc: "2.0", id: 1, method: MCP_SAMPLING_METHOD, params: SAMPLE })
    await flush()
    const reply = t.last()
    expect(reply.id).toBe(1)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32000)
    expect(err.message).toContain("no-handler")
    expect(reply.result).toBeUndefined()
    await client.stop()
  })

  it("(h) consent prompter that THROWS ⇒ user-denied, LLM NEVER called", async () => {
    const t = new ScriptedTransport()
    const { llm, calls } = fakeLlm()
    const handler = createLlmSamplingHandler({ llm, consent: throwingConsent() })
    const client = await startClient(CONFIG, { samplingHandler: handler }, t)
    t.emit({ jsonrpc: "2.0", id: 2, method: MCP_SAMPLING_METHOD, params: SAMPLE })
    await flush()
    const err = t.last().error as { code: number; message: string }
    expect(err.message).toContain("user-denied")
    expect(calls()).toBe(0)
    await client.stop()
  })

  it("(b2) malformed createMessage params (every garbage shape) ⇒ decline, LLM never called", async () => {
    const { llm, calls } = fakeLlm()
    const handler = createLlmSamplingHandler({ llm, consent: consentOf({ ok: true, value: true }) })
    // Each of these MUST be declined by the router BEFORE the handler/LLM runs.
    const garbage: unknown[] = [
      {}, // no messages
      { messages: [] }, // empty
      { messages: "not-an-array" },
      { messages: [{ role: "system", content: "x" }] }, // invalid role only
      { messages: [42, null, "x"] }, // no well-formed entry
      null,
      "a string",
      [1, 2, 3],
      { messages: [{ content: "no role" }] },
    ]
    for (const params of garbage) {
      const res = await routeSampling(handler, MCP_SAMPLING_METHOD, params)
      expect(res.kind).toBe("error")
    }
    expect(calls()).toBe(0) // not one of the malformed requests reached the LLM
  })

  it("(b3) a handler that THROWS is mapped to a decline by the router (never drops)", async () => {
    const throwingHandler: SamplingHandlerPort = {
      createMessage: async () => {
        throw new Error("handler exploded")
      },
    }
    const res = await routeSampling(throwingHandler, MCP_SAMPLING_METHOD, SAMPLE)
    expect(res.kind).toBe("error")
    if (res.kind === "error") expect(res.message).toContain("handler error")
  })

  it("(b4) isSamplingMethod is exact — sibling/forged method names are NOT routed", () => {
    expect(isSamplingMethod(MCP_SAMPLING_METHOD)).toBe(true)
    expect(isSamplingMethod("sampling/createMessage ")).toBe(false)
    expect(isSamplingMethod("SAMPLING/CREATEMESSAGE")).toBe(false)
    expect(isSamplingMethod("sampling/createMessage2")).toBe(false)
    expect(isSamplingMethod("notifications/sampling/createMessage")).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (f) — inbound method dispatch: UNKNOWN ⇒ -32601; recognized-but-UNADVERTISED
//       outbound ⇒ typed `unsupported` with NO request on the wire.
// ═════════════════════════════════════════════════════════════════════════════

describe("inbound/outbound method gating (-32601 vs typed unsupported)", () => {
  it("(f1) an UNKNOWN inbound method gets a raw -32601 (server not left hanging)", async () => {
    const t = new ScriptedTransport()
    const client = await startClient(CONFIG, {}, t)
    t.emit({ jsonrpc: "2.0", id: 9, method: "evil/unknownMethod", params: {} })
    await flush()
    const reply = t.last()
    expect(reply.id).toBe(9)
    const err = reply.error as { code: number; message: string }
    expect(err.code).toBe(-32601)
    expect(err.message).toContain("evil/unknownMethod")
    await client.stop()
  })

  it("(f2) recognized-but-UNADVERTISED resources/prompts ⇒ typed unsupported, NO request emitted", async () => {
    const t = new ScriptedTransport()
    t.serverCaps = {} // server advertises NOTHING
    const client = await startClient(CONFIG, {}, t)
    const before = t.outboundMethods().length

    const r = await client.readResource("file:///x")
    const p = await client.getPrompt("greet")
    const s = await client.subscribeResource("file:///x")

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unsupported")
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reason).toBe("unsupported")
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toBe("unsupported")

    // CRITICAL: no `resources/read`, `prompts/get`, or `resources/subscribe`
    // ever went on the wire (we refuse locally, never round-trip a -32601).
    const after = t.outboundMethods()
    expect(after.length).toBe(before) // not one extra outbound request
    expect(after).not.toContain("resources/read")
    expect(after).not.toContain("prompts/get")
    expect(after).not.toContain("resources/subscribe")
    await client.stop()
  })

  it("(f3) advertised-but-no-subscribe ⇒ subscribe refused unsupported, list/read still allowed", async () => {
    const t = new ScriptedTransport({ manual: true })
    // resources advertised WITHOUT subscribe.
    const client = new McpClient(CONFIG, { transport: t })
    const startP = client.start()
    await flush()
    const init = t.sent.find((s) => s.payload.method === "initialize")?.payload as { id: number }
    t.emit({ jsonrpc: "2.0", id: init.id, result: { capabilities: { resources: {} } } })
    await startP
    expect(client.serverSupportsResources()).toBe(true)
    expect(client.serverSupportsResourceSubscribe()).toBe(false)
    const sub = await client.subscribeResource("file:///x")
    expect(sub.ok).toBe(false)
    if (!sub.ok) expect(sub.reason).toBe("unsupported")
    await client.stop()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (a) + (e) — capability-spoof + huge blob: advertise resources, return garbage
//             or a multi-MB blob ⇒ typed malformed / parsed intact, never throw.
// ═════════════════════════════════════════════════════════════════════════════

describe("H19 resources — spoofed/garbage/huge server responses (no throw)", () => {
  it("(a1) advertise resources then return garbage on read ⇒ typed malformed, no throw", async () => {
    const t = new ScriptedTransport({ manual: true })
    const client = new McpClient(CONFIG, { transport: t })
    const startP = client.start()
    await flush()
    const init = t.sent.find((s) => s.payload.method === "initialize")?.payload as { id: number }
    t.emit({ jsonrpc: "2.0", id: init.id, result: { capabilities: { resources: {} } } })
    await startP

    // garbage: `contents` is not an array → parseResourceRead returns null → malformed
    const readP = client.readResource("file:///x")
    await flush()
    const readReq = t.sent.find((s) => s.payload.method === "resources/read")?.payload as {
      id: number
    }
    t.emit({ jsonrpc: "2.0", id: readReq.id, result: { contents: "not-an-array" } })
    const res = await readP
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("malformed")
    await client.stop()
  })

  it("(e) resources/read with a multi-MB base64 blob ⇒ parsed intact, no truncation/throw", () => {
    const bigBlob = "QUFB".repeat(1_000_000) // ~4MB base64-looking string
    const parsed = parseResourceRead({
      contents: [{ uri: "file:///big", mimeType: "application/octet-stream", blob: bigBlob }],
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.length).toBe(1)
    expect(parsed?.[0]?.blob?.length).toBe(bigBlob.length) // intact, not truncated
    expect(parsed?.[0]?.uri).toBe("file:///big")
  })

  it("(a2) parseResourceRead drops malformed entries but keeps valid ones (defensive narrowing)", () => {
    const parsed = parseResourceRead({
      contents: [
        { uri: "file:///ok", text: "good" },
        { /* no uri */ text: "dropped" },
        null,
        42,
        { uri: 123 /* non-string uri */, text: "dropped" },
        { uri: "file:///ok2", blob: "AAAA" },
      ],
    })
    expect(parsed?.map((c) => c.uri)).toEqual(["file:///ok", "file:///ok2"])
  })

  it("(a3) a parser given a non-object / array top-level returns null (malformed), no throw", () => {
    expect(parseResourceRead(null)).toBeNull()
    expect(parseResourceRead([])).toBeNull()
    expect(parseResourceRead("x")).toBeNull()
    expect(parseResourceRead({ contents: 5 })).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (g'-roots) — inbound roots/list: throwing/garbage provider ⇒ sanitized/empty,
//              never -32601, never a throw.
// ═════════════════════════════════════════════════════════════════════════════

describe("H19 roots — hostile provider + inbound robustness", () => {
  it("(roots1) a provider that THROWS ⇒ empty roots result (never drops, never -32601)", () => {
    const throwing: RootsProviderPort = {
      listRoots: () => {
        throw new Error("provider exploded")
      },
    }
    const res = routeRootsList(throwing, MCP_ROOTS_LIST_METHOD)
    expect(res.roots).toEqual([])
  })

  it("(roots2) a provider returning garbage roots ⇒ only well-typed uris survive", () => {
    const garbage = {
      listRoots: () =>
        [
          { uri: "file:///ok", name: "good" },
          { uri: "" }, // empty uri dropped
          { uri: 42 }, // non-string dropped
          { name: "no-uri" }, // missing uri dropped
          { uri: "file:///ok2", name: 99 }, // bad name dropped, uri kept
        ] as never,
    }
    const res = routeRootsList(garbage as RootsProviderPort, MCP_ROOTS_LIST_METHOD)
    expect(res.roots).toEqual([
      { uri: "file:///ok" /* name */, name: "good" },
      { uri: "file:///ok2" },
    ])
  })

  it("(roots3) inbound roots/list answered EMPTY (never -32601) when no provider wired", async () => {
    const t = new ScriptedTransport()
    const client = await startClient(CONFIG, {}, t) // NO rootsProvider
    t.emit({ jsonrpc: "2.0", id: 5, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = t.last()
    expect(reply.id).toBe(5)
    expect(reply.error).toBeUndefined() // NOT -32601
    expect(reply.result).toEqual({ roots: [] })
    await client.stop()
  })

  it("(roots4) isRootsMethod is exact (no sibling/forged match)", () => {
    expect(isRootsMethod(MCP_ROOTS_LIST_METHOD)).toBe(true)
    expect(isRootsMethod("roots/list ")).toBe(false)
    expect(isRootsMethod("roots/listChanged")).toBe(false)
    expect(isRootsMethod("notifications/roots/list_changed")).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// advertise-iff-able byte-identity of the negotiator (default-OFF construction).
// ═════════════════════════════════════════════════════════════════════════════

describe("capability negotiator — advertise-iff-able byte identity", () => {
  it("default fullNegotiator omits sampling+roots; opting in adds EXACTLY them (canonical order)", () => {
    const base = JSON.stringify(fullNegotiator().compile())
    expect(JSON.parse(base)).toEqual({
      elicitation: {},
      tasks: { listChanged: false },
      tools: {},
    })
    // Two separate compiles of the default are byte-identical (no shared mutable state).
    expect(JSON.stringify(fullNegotiator().compile())).toBe(base)

    const both = fullNegotiator({ sampling: true, roots: true }).compile()
    // Canonical alphabetical key order: elicitation < roots < sampling < tasks < tools.
    expect(Object.keys(both)).toEqual(["elicitation", "roots", "sampling", "tasks", "tools"])
    expect(both.sampling).toEqual({})
    expect(both.roots).toEqual({ listChanged: false })

    // A mutating caller of one compiled record cannot poison the next compile.
    const a = fullNegotiator({ sampling: true }).compile() as Record<string, unknown>
    a.tools = { poisoned: true }
    expect(JSON.stringify(fullNegotiator().compile())).toBe(base)
  })

  it("sampling-only and roots-only each insert ONLY their key (honest partial advertise)", () => {
    expect(Object.keys(fullNegotiator({ sampling: true }).compile())).toEqual([
      "elicitation",
      "sampling",
      "tasks",
      "tools",
    ])
    expect(Object.keys(fullNegotiator({ roots: true }).compile())).toEqual([
      "elicitation",
      "roots",
      "tasks",
      "tools",
    ])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (d) — bounded 401 retry: a server that 401s even with FRESH must retry EXACTLY
//       ONCE then surface (no infinite loop).
// ═════════════════════════════════════════════════════════════════════════════

/** A transport that 401s EVERY request whose bearer is in `staleSet`. When
 *  `only401Method` is set, ONLY that method is gated by staleness (every other
 *  method — notably `initialize` — always succeeds, so a re-auth rebuild always
 *  re-handshakes cleanly and the 401 is isolated to the steady-state request). */
const make401Transport = (
  headers: () => Record<string, string>,
  staleSet: Set<string>,
  only401Method?: string,
) => {
  let onMsg: ((m: JsonRpcMessage) => void) | null = null
  let sends = 0
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
      sends += 1
      const bearer = (headers().Authorization ?? "").replace(/^Bearer /, "")
      const gated = only401Method === undefined || p.method === only401Method
      if (gated && staleSet.has(bearer)) {
        queueMicrotask(() =>
          onMsg?.({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "transport POST failed: HTTP 401" },
          } as JsonRpcMessage),
        )
        return null
      }
      const result = p.method === "initialize" ? { capabilities: {} } : { tools: [] }
      queueMicrotask(() => onMsg?.({ jsonrpc: "2.0", id, result } as JsonRpcMessage))
      return null
    },
    async close() {},
  }
  return { transport, sends: () => sends }
}

const httpConfig = (): McpServerConfig => ({
  name: "remote",
  command: [],
  url: "https://mcp.example.com/rpc",
  oauth: true,
})

describe("H18 OAuth — bounded 401 retry (no infinite loop)", () => {
  it("(d) server 401s EVEN with the fresh bearer ⇒ retried EXACTLY once, then surfaces", async () => {
    // The provider always hands back tokens that the server rejects. The client
    // must NOT loop: one re-auth + one retry, then the 401 surfaces.
    let asks = 0
    const provider: McpOAuthProviderPort & { asks: () => number; inval: () => number } = (() => {
      let inval = 0
      return {
        asks: () => asks,
        inval: () => inval,
        tokenFor: async () => {
          asks += 1
          return `TOK-${asks}` // always a DIFFERENT token, but still rejected
        },
        invalidate: async () => {
          inval += 1
        },
      }
    })()

    // EVERY token TOK-* is stale for `tools/list` (the server rejects all of
    // them). `initialize` is NOT gated, so a re-auth rebuild always re-handshakes
    // cleanly and the 401 is isolated to the steady-state request — proving the
    // retry is BOUNDED rather than the rebuild itself looping.
    const staleSet = new Set<string>(["TOK-1", "TOK-2", "TOK-3", "TOK-4", "TOK-5"])
    let headers: Record<string, string> = {}
    let activeTransport: ReturnType<typeof make401Transport> | null = null

    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      transport: (cfg) => {
        headers = cfg.headers ?? {}
        activeTransport = make401Transport(() => headers, staleSet, "tools/list")
        return activeTransport.transport
      },
    })

    await client.start() // initialize with TOK-1 succeeds (initialize not gated)
    // tools/list with TOK-1 → 401 → re-auth → TOK-2 → rebuilt carrier (initialize
    // ok) → tools/list retried ONCE with TOK-2 → SECOND 401 surfaces (NO loop).
    await expect(client.listTools()).rejects.toThrow()

    // BOUNDED: exactly one re-auth. A loop would invalidate / re-ask unboundedly.
    expect(provider.inval()).toBe(1)
    // asks: 1 (start bearer) + 1 (single re-auth) = 2. A loop would be >> 2.
    expect(provider.asks()).toBe(2)
    expect(activeTransport).not.toBeNull()
    await client.stop()
  })

  it("(d2) a 401 with NO oauth opt-in ⇒ surfaced as a plain error (re-auth path never entered)", async () => {
    const staleSet = new Set<string>([""]) // empty bearer is 'stale'
    const { transport } = make401Transport(() => ({}), staleSet)
    const cfg: McpServerConfig = { name: "remote", command: [], url: "https://x/rpc" } // no oauth
    const client = new McpClient(cfg, { transport })
    await client.start().catch(() => {})
    await expect(client.listTools()).rejects.toThrow()
    await client.stop()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (c) — token-no-leak via LOG capture: a refresh-fail → re-auth path emits log
//       diagnostics but NEVER the bearer/refresh token.
// ═════════════════════════════════════════════════════════════════════════════

const jsonResponse = (status: number, body: unknown): FetchPortResponse => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
})

const SECRET_ACCESS = "SUPER-SECRET-ACCESS-TOKEN-abc123"
const SECRET_REFRESH = "SUPER-SECRET-REFRESH-TOKEN-xyz789"

/** A fake IdP that mints the secret tokens, then FAILS every refresh (forcing
 *  the re-auth log path) and finally fails discovery on re-auth (forcing the
 *  total-contract warn path) — both log paths must omit the tokens. */
const leakProbeIdp = (issuer: string) => {
  let failAll = false
  const fetchPort: FetchPort = async (url, init) => {
    if (failAll) return jsonResponse(500, { error: "down" })
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return jsonResponse(200, {
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      })
    }
    if (url === `${issuer}/token`) {
      const isRefresh = (init?.body ?? "").includes("refresh_token")
      if (isRefresh) return jsonResponse(400, { error: "invalid_grant" }) // refresh always fails
      return jsonResponse(200, {
        access_token: SECRET_ACCESS,
        refresh_token: SECRET_REFRESH,
        token_type: "Bearer",
        expires_in: 3600,
      })
    }
    return jsonResponse(404, {})
  }
  return {
    fetchPort,
    breakEverything: () => {
      failAll = true
    },
  }
}

const fakeStore = () => {
  const map = new Map<string, TokenRecord>()
  const port: TokenStorePort = {
    read: async (id) => map.get(id),
    write: async (id, rec) => {
      map.set(id, rec)
    },
    delete: async (id) => {
      map.delete(id)
    },
  }
  return port
}

const fakeClock = (start = 1_000_000): ClockPort & { advance: (ms: number) => void } => {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe("H18 OAuth — tokens never reach the log sink (stderr capture)", () => {
  it("(c) refresh-fail then total-contract failure log NEITHER the access NOR refresh token", async () => {
    const issuer = "https://idp.example.com"
    const idp = leakProbeIdp(issuer)
    const clock = fakeClock()
    let browserRuns = 0
    const provider = createConnectorsMcpOAuthProvider({
      fetchPort: idp.fetchPort,
      tokenStore: fakeStore(),
      clockPort: clock,
      runBrowserFlow: async () => {
        browserRuns += 1
        return { code: "C", verifier: "V", redirectUri: "http://localhost/cb" }
      },
      clientId: "cid",
      issuerFor: () => issuer,
    })

    // Capture EVERYTHING the logger writes to stderr.
    const captured: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    // biome-ignore lint/suspicious/noExplicitAny: test stub for the stderr sink
    ;(process.stderr.write as unknown as any) = (chunk: unknown): boolean => {
      captured.push(String(chunk))
      return true
    }
    try {
      // 1) first token (mints the secrets, stored).
      const first = await provider.tokenFor("srv")
      expect(first).toBe(SECRET_ACCESS)
      // 2) expire → refresh fails (400) → re-auth log path fires (logger.info).
      clock.advance(3_600_001)
      const reauthed = await provider.tokenFor("srv")
      expect(reauthed).toBe(SECRET_ACCESS) // re-auth minted a fresh access token
      // browser flow ran twice: once for the initial auth, once for the re-auth
      // after the refresh grant was rejected (400 invalid_grant).
      expect(browserRuns).toBe(2)
      // 3) break the IdP entirely, expire again → refresh fails AND re-auth
      //    discovery fails → total-contract warn path fires (logger.warn).
      clock.advance(3_600_001)
      idp.breakEverything()
      const failed = await provider.tokenFor("srv")
      expect(failed).toBeUndefined() // total contract: degrade to unauthenticated
    } finally {
      ;(process.stderr.write as unknown) = orig
    }

    const all = captured.join("")
    // Diagnostics WERE emitted (we exercised both the re-auth + total-contract paths)…
    expect(all.length).toBeGreaterThan(0)
    expect(all).toContain("mcp-oauth")
    // …but NEVER the tokens.
    expect(all).not.toContain(SECRET_ACCESS)
    expect(all).not.toContain(SECRET_REFRESH)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (g) — reconnect: after an OAuth carrier REBUILD (mid-session 401 → re-auth),
//       the inbound sampling handler + roots provider STILL answer (dispatch
//       re-wired onto the rebuilt carrier).
// ═════════════════════════════════════════════════════════════════════════════

describe("supervised/OAuth reconnect — inbound capabilities survive carrier rebuild", () => {
  it("(g) after a 401 carrier-rebuild, inbound sampling + roots still answer on the NEW carrier", async () => {
    // A rotating provider: STALE first, FRESH after invalidate.
    let asks = 0
    const provider: McpOAuthProviderPort = {
      tokenFor: async () => {
        const t = asks === 0 ? "STALE" : "FRESH"
        asks += 1
        return t
      },
      invalidate: async () => {},
    }
    const staleSet = new Set<string>(["STALE"])
    let headers: Record<string, string> = {}
    // Track the LIVE transport so we can emit inbound requests onto the rebuilt one.
    let live: ScriptedTransport | null = null

    const { llm, calls } = fakeLlm()
    const handler = createLlmSamplingHandler({ llm, consent: consentOf({ ok: true, value: true }) })
    const roots: RootsProviderPort = { listRoots: () => [{ uri: "file:///ws", name: "workspace" }] }

    const client = new McpClient(httpConfig(), {
      oauthProvider: provider,
      samplingHandler: handler,
      rootsProvider: roots,
      negotiator: fullNegotiator({ sampling: true, roots: true }),
      transport: (cfg) => {
        headers = cfg.headers ?? {}
        const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "")
        if (bearer === "FRESH") staleSet.delete("STALE")
        // A scripted transport that 401s on stale bearer, else answers handshake.
        const t = new ScriptedTransport({ headers: () => headers })
        // Override send to 401 on stale bearer for the mid-session request.
        const origSend = t.send.bind(t)
        t.send = (payload: unknown): Error | null => {
          const p = payload as Record<string, unknown>
          const b = (headers.Authorization ?? "").replace(/^Bearer /, "")
          if (typeof p.id === "number" && staleSet.has(b) && p.method === "tools/list") {
            ;(t as unknown as { sent: Sent[] }).sent.push({
              payload: p,
              auth: headers.Authorization,
            })
            queueMicrotask(() =>
              t.emit({
                jsonrpc: "2.0",
                id: p.id as number,
                error: { code: -32000, message: "HTTP 401" },
              }),
            )
            return null
          }
          return origSend(payload)
        }
        live = t
        return t
      },
    })

    await client.start() // initialize with STALE succeeds (only tools/list 401s)
    await client.listTools() // STALE 401 → re-auth FRESH → carrier rebuilt → ok

    expect(headers.Authorization).toBe("Bearer FRESH")
    expect(live).not.toBeNull()

    // The rebuilt carrier must still route inbound sampling + roots to OUR ports.
    const t = live as unknown as ScriptedTransport
    t.emit({ jsonrpc: "2.0", id: 201, method: MCP_SAMPLING_METHOD, params: SAMPLE })
    await flush()
    const sReply = t.last()
    expect(sReply.id).toBe(201)
    expect(sReply.error).toBeUndefined()
    expect(calls()).toBe(1) // reached our LLM via the rebuilt carrier

    t.emit({ jsonrpc: "2.0", id: 202, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const rReply = t.last()
    expect(rReply.id).toBe(202)
    expect(rReply.result).toEqual({ roots: [{ uri: "file:///ws", name: "workspace" }] })

    await client.stop()
  })
})
