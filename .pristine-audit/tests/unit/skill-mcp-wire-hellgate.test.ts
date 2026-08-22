/**
 * ★ HELLGATE — `buildSkillMcpHttpConnect` (ADR-0476 composition-root, the ACTUAL
 * assembler-called HTTP-carrier seam in `src/agent/skill-mcp-wire.ts`).
 *
 * WHY this file exists: the slice/adapter hellgates and the e2e lifecycle test
 * (`skill-mcp-e2e-hellgate.test.ts`) deliberately STUB the http builder — the
 * e2e `wire()` substitutes a `fakeHttpConnect` for `buildSkillMcpHttpConnect`,
 * and the assembler section only asserts `cfg.skillMcpSession` is defined. So the
 * builder's OWN composition-root logic — its only non-port code — had ZERO
 * behavioral coverage (no test imported `@/agent/skill-mcp-wire`). This pins the
 * three branches that are exclusively the builder's:
 *
 *   A. empty / whitespace-only `url` ⇒ REJECTS without opening any client
 *      (`skill-mcp-wire.ts` empty-url guard) — pure, no I/O.
 *   B. a client whose `start()` fails (the `initialize` POST rejects at the
 *      connection level) ⇒ the builder best-effort `stop()`s the half-open
 *      client, then REJECTS (NO leaked carrier) — `start()`-throws cleanup path.
 *   C. ok handshake ⇒ returns an `HttpMcpConnection` whose `stop()` is
 *      idempotent + NO-THROW (a second `stop()` is a clean no-op).
 *
 * SEAM: the builder hard-wires `new HttpSseMcpTransport({ url, name })` (no fetch
 * injection — that's correct; it's the production wiring). We drive B/C through
 * the transport's documented default-fetch seam by overriding `globalThis.fetch`
 * with an in-memory fake (restored in `finally`). NO real socket, NO real
 * process, NO network — deterministic. The fake answers exactly the three calls
 * the Streamable-HTTP transport makes during a handshake: the standalone GET
 * (answered 405 ⇒ POST-only, spec-legal), the `initialize` POST (id:1), and the
 * `notifications/initialized` notification POST (no id ⇒ 202).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { buildSkillMcpHttpConnect } from "@/agent/skill-mcp-wire"
import type { McpServerSpec } from "@/skill/skill-mcp-deps"

// --- in-memory fetch fake (the transport's only outbound seam) --------------

type FetchInit = { method: string; headers: Record<string, string>; body?: string }
type FetchResp = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  body: ReadableStream<Uint8Array> | null
}

const noHeaders = { get: (): string | null => null }

/** A 405 for the standalone GET: server has no server-initiated stream — the
 *  transport proceeds POST-only (spec-legal). */
const resp405 = (): FetchResp => ({
  ok: false,
  status: 405,
  headers: noHeaders,
  text: async () => "",
  body: null,
})

/** A single-JSON 200 carrying the `initialize` reply (id:1, first request). */
const respInitOk = (): FetchResp => ({
  ok: true,
  status: 200,
  headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
  text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
  body: null,
})

/** A 202 for the fire-and-forget `notifications/initialized` POST (no body). */
const resp202 = (): FetchResp => ({
  ok: true,
  status: 202,
  headers: noHeaders,
  text: async () => "",
  body: null,
})

/** Install an in-memory `globalThis.fetch`; returns a call-count + restorer. */
const installFetch = (
  handler: (init: FetchInit) => FetchResp,
): { calls: () => number; methods: () => readonly string[]; restore: () => void } => {
  const original = globalThis.fetch
  const methods: string[] = []
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const i = (init ?? { method: "GET", headers: {} }) as FetchInit
    methods.push(i.method)
    return handler(i)
  }) as unknown as typeof globalThis.fetch
  return {
    calls: () => methods.length,
    methods: () => [...methods],
    restore: () => {
      globalThis.fetch = original
    },
  }
}

let activeRestore: (() => void) | null = null
afterEach(() => {
  activeRestore?.()
  activeRestore = null
})

const httpSpec = (
  over: Partial<Omit<McpServerSpec, "url">> & { url?: string | undefined } = {},
): McpServerSpec =>
  ({
    serviceName: "remote",
    transport: "streamable_http",
    url: "https://mcp.example.com/v1",
    ...over,
  }) as McpServerSpec

// ---------------------------------------------------------------------------
// A. empty / whitespace url ⇒ reject WITHOUT opening any client (no fetch).
// ---------------------------------------------------------------------------

describe("A. empty-url guard rejects before opening any client", () => {
  for (const url of [undefined, "", "   ", "\t\n"] as const) {
    test(`A — url=${JSON.stringify(url)} ⇒ rejects, fetch never called`, async () => {
      const fx = installFetch(() => resp405())
      activeRestore = fx.restore
      const port = buildSkillMcpHttpConnect()
      await expect(port.connect(httpSpec({ url }), "id-a")).rejects.toThrow(/empty url for remote/)
      // The guard short-circuits BEFORE constructing the transport/client, so the
      // global fetch is never touched — proof nothing half-opened.
      expect(fx.calls()).toBe(0)
    })
  }
})

// ---------------------------------------------------------------------------
// B. start() fails mid-handshake ⇒ best-effort stop() then REJECT (no leak).
// ---------------------------------------------------------------------------

describe("B. failed handshake collapses to a reject (no leaked carrier)", () => {
  test("B — initialize POST rejects (connection-level) ⇒ connect rejects", async () => {
    // GET (standalone stream) ⇒ 405 (proceed POST-only). The initialize POST ⇒
    // the fetch REJECTS (DNS/refused/reset), which the transport correlates back
    // to the pending request and rejects PROMPTLY (no 30s timeout). The client's
    // start() therefore throws ⇒ the builder stop()s + re-throws.
    const fx = installFetch((init) => {
      if (init.method === "GET") return resp405()
      throw new Error("ECONNREFUSED")
    })
    activeRestore = fx.restore
    const port = buildSkillMcpHttpConnect()
    await expect(port.connect(httpSpec(), "id-b")).rejects.toThrow(
      /skill-mcp http connect failed for remote/,
    )
    // start() got far enough to POST (GET + the failed initialize POST). The
    // builder's catch ran client.stop(); because no session id was ever assigned
    // (the POST failed), stop() issues NO DELETE — so the only calls are the GET
    // + the one rejected POST. Crucially: connect rejected, nothing returned, so
    // there is no untracked HttpMcpConnection holding a live client.
    expect(fx.methods().filter((m) => m === "POST").length).toBe(1)
  })

  test("B2 — initialize POST returns HTTP 500 ⇒ connect still rejects (prompt-fail)", async () => {
    const fx = installFetch((init) => {
      if (init.method === "GET") return resp405()
      return { ok: false, status: 500, headers: noHeaders, text: async () => "", body: null }
    })
    activeRestore = fx.restore
    const port = buildSkillMcpHttpConnect()
    await expect(port.connect(httpSpec(), "id-b2")).rejects.toThrow(
      /skill-mcp http connect failed for remote/,
    )
  })
})

// ---------------------------------------------------------------------------
// C. ok handshake ⇒ a connection whose stop() is idempotent + NO-THROW.
// ---------------------------------------------------------------------------

describe("C. successful connect yields an idempotent, no-throw connection", () => {
  test("C — connect resolves; stop() twice ⇒ no throw, carries the passed id", async () => {
    const fx = installFetch((init) => {
      if (init.method === "GET") return resp405() // no standalone stream
      // The first POST is `initialize` (id:1) ⇒ JSON reply; the
      // `notifications/initialized` POST (no id) ⇒ 202.
      const body = init.body ?? ""
      return body.includes('"id":1') ? respInitOk() : resp202()
    })
    activeRestore = fx.restore
    const port = buildSkillMcpHttpConnect()
    const conn = await port.connect(httpSpec(), "id-c")
    // The builder passes `id` straight through onto the connection for diagnostics.
    expect(conn.id).toBe("id-c")
    // Idempotent + NO-THROW teardown contract (wraps McpClient.stop()'s
    // `if (stopped) return`): two stop()s must both resolve cleanly.
    await expect(conn.stop()).resolves.toBeUndefined()
    await expect(conn.stop()).resolves.toBeUndefined()
  })
})
