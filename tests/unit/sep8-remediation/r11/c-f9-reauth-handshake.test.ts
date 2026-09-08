/**
 * C-F9 — stateful HTTP reauth: 401 → new session id + protocol pin + allowed retry.
 * Handshake 401, concurrent 401 single-flight, stop-during-refresh, late old
 * response ignored, tools/call not auto-replayed.
 */
import { describe, expect, test } from "bun:test"
import { McpClient, type McpOAuthProviderPort, type McpServerConfig } from "@/mcp"
import { isReplayableAfterReauth } from "@/mcp/client/reauthorize"
import { LATEST_PROTOCOL_VERSION } from "@/mcp/protocol-version"
import {
  type HttpFetchFn,
  type HttpFetchResponse,
  HttpSseMcpTransport,
} from "@/mcp/transports/http-sse"

const jsonHeaders = (extra: Record<string, string | null> = {}): HttpFetchResponse["headers"] => ({
  get: (name: string) => {
    const key = name.toLowerCase()
    if (key === "content-type") return "application/json"
    for (const [k, v] of Object.entries(extra)) {
      if (k.toLowerCase() === key) return v
    }
    return null
  },
})

const jsonOk = (id: number, result: unknown, sessionId: string | null): HttpFetchResponse => ({
  ok: true,
  status: 200,
  headers: jsonHeaders(sessionId !== null ? { "mcp-session-id": sessionId } : {}),
  text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }),
  body: null,
})

const accepted = (): HttpFetchResponse => ({
  ok: true,
  status: 202,
  headers: jsonHeaders(),
  text: async () => "",
  body: null,
})

const httpErr = (status: number): HttpFetchResponse => ({
  ok: false,
  status,
  headers: jsonHeaders(),
  text: async () => "",
  body: null,
})

const sse405 = (): HttpFetchResponse => ({
  ok: false,
  status: 405,
  headers: jsonHeaders(),
  text: async () => "",
  body: null,
})

interface FixtureOpts {
  staleBearers?: Set<string>
  failInitializeFor?: Set<string>
}

const parseRpc = (
  body: string | undefined,
): { id?: number; method?: string; params?: { protocolVersion?: string } } =>
  body
    ? (JSON.parse(body) as {
        id?: number
        method?: string
        params?: { protocolVersion?: string }
      })
    : {}

const sessionOk = (
  session: string | undefined,
  sessions: Map<string, { protocol: string; bearer: string }>,
  deleted: Set<string>,
  protocol: string | undefined,
): boolean => {
  if (session === undefined || !sessions.has(session) || deleted.has(session)) return false
  const sess = sessions.get(session)
  return !(sess && protocol !== undefined && protocol !== sess.protocol)
}

const replyForMethod = (method: string | undefined, id: number | undefined): HttpFetchResponse => {
  if (method === "tools/list") {
    return jsonOk(
      id as number,
      { tools: [{ name: "echo", description: "", inputSchema: {} }] },
      null,
    )
  }
  if (method === "tools/call") {
    return jsonOk(id as number, { content: [{ type: "text", text: "ran" }], isError: false }, null)
  }
  return accepted()
}

interface FixtureState {
  stale: Set<string>
  failInit: Set<string>
  next: number
  sessions: Map<string, { protocol: string; bearer: string }>
  deleted: Set<string>
  log: Array<{
    method: string
    rpc?: string
    session?: string | undefined
    protocol?: string | undefined
    bearer: string
  }>
  initializeCount: number
  toolsCallCount: number
  toolsListCount: number
}

const record = (
  state: FixtureState,
  method: string,
  bearer: string,
  session: string | undefined,
  protocol: string | undefined,
  rpc?: string,
): void => {
  state.log.push({
    method,
    bearer,
    session,
    protocol,
    ...(rpc !== undefined ? { rpc } : {}),
  })
}

const handleDelete = (
  state: FixtureState,
  bearer: string,
  session: string | undefined,
  protocol: string | undefined,
): HttpFetchResponse => {
  if (session !== undefined && session !== "") state.deleted.add(session)
  record(state, "DELETE", bearer, session, protocol)
  return { ok: true, status: 200, headers: jsonHeaders(), text: async () => "", body: null }
}

const mintSession = (
  state: FixtureState,
  payload: ReturnType<typeof parseRpc>,
  bearer: string,
): HttpFetchResponse => {
  state.initializeCount += 1
  const id = `sess-${state.next++}`
  const pin = payload.params?.protocolVersion ?? LATEST_PROTOCOL_VERSION
  state.sessions.set(id, { protocol: pin, bearer })
  return jsonOk(payload.id as number, { protocolVersion: pin, capabilities: { tools: {} } }, id)
}

const routePost = (
  state: FixtureState,
  payload: ReturnType<typeof parseRpc>,
  bearer: string,
  session: string | undefined,
  protocol: string | undefined,
): HttpFetchResponse => {
  if (state.stale.has(bearer) && payload.method !== "initialize") return httpErr(401)
  if (payload.method === "initialize" && state.failInit.has(bearer)) return httpErr(401)
  if (payload.method === "initialize") return mintSession(state, payload, bearer)
  if (payload.method === "notifications/initialized") return accepted()
  if (!sessionOk(session, state.sessions, state.deleted, protocol)) return httpErr(400)
  return replyForMethod(payload.method, payload.id)
}

const handlePost = (state: FixtureState, init: Parameters<HttpFetchFn>[1]): HttpFetchResponse => {
  const bearer = (init.headers.Authorization ?? "").replace(/^Bearer /, "")
  const session = init.headers["mcp-session-id"]
  const protocol = init.headers["mcp-protocol-version"]
  const payload = parseRpc(init.body)
  record(state, init.method, bearer, session, protocol, payload.method)
  if (payload.method === "tools/call") state.toolsCallCount += 1
  if (payload.method === "tools/list") state.toolsListCount += 1
  return routePost(state, payload, bearer, session, protocol)
}

const statefulHttp = (opts: FixtureOpts = {}) => {
  const state: FixtureState = {
    stale: opts.staleBearers ?? new Set(["STALE"]),
    failInit: opts.failInitializeFor ?? new Set<string>(),
    next: 1,
    sessions: new Map(),
    deleted: new Set(),
    log: [],
    initializeCount: 0,
    toolsCallCount: 0,
    toolsListCount: 0,
  }

  const fetchFn: HttpFetchFn = async (_url, init) => {
    if (init.method === "GET") return sse405()
    const bearer = (init.headers.Authorization ?? "").replace(/^Bearer /, "")
    const session = init.headers["mcp-session-id"]
    const protocol = init.headers["mcp-protocol-version"]
    if (init.method === "DELETE") return handleDelete(state, bearer, session, protocol)
    return handlePost(state, init)
  }

  return {
    fetchFn,
    log: () => state.log,
    deleted: () => state.deleted,
    sessions: () => state.sessions,
    initializeCount: () => state.initializeCount,
    toolsCallCount: () => state.toolsCallCount,
    toolsListCount: () => state.toolsListCount,
    stale: state.stale,
  }
}

const rotatingProvider = (opts?: {
  hold?: () => Promise<void>
}): McpOAuthProviderPort & { asks: () => number; invals: () => number } => {
  let asks = 0
  let invals = 0
  const tokens = ["STALE", "FRESH"]
  return {
    asks: () => asks,
    invals: () => invals,
    tokenFor: async () => {
      if (opts?.hold !== undefined && asks >= 1) await opts.hold()
      const t = tokens[Math.min(asks, tokens.length - 1)] as string
      asks += 1
      return t
    },
    invalidate: async () => {
      invals += 1
    },
  }
}

const cfg = (): McpServerConfig => ({
  name: "remote",
  command: [],
  url: "https://mcp.example.com/rpc",
  oauth: true,
})

const makeClient = (fetchFn: HttpFetchFn, provider: McpOAuthProviderPort) => {
  let headers: Record<string, string> = {}
  let builds = 0
  const client = new McpClient(cfg(), {
    oauthProvider: provider,
    transport: (c) => {
      builds += 1
      headers = c.headers ?? {}
      return new HttpSseMcpTransport({
        url: c.url ?? "https://mcp.example.com/rpc",
        name: c.name,
        ...(c.headers !== undefined ? { headers: c.headers } : {}),
        fetch: fetchFn,
        openServerStream: false,
      })
    },
  })
  return { client, headers: () => headers, builds: () => builds }
}

describe("C-F9 stateful HTTP reauth", () => {
  test("401 → new session id + protocol pin + tools/list retry", async () => {
    const fx = statefulHttp()
    const provider = rotatingProvider()
    const { client, headers, builds } = makeClient(fx.fetchFn, provider)
    await client.start()
    const firstSession = [...fx.sessions().keys()][0]
    expect(firstSession).toBeDefined()
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(fx.initializeCount()).toBe(2)
    const sessionIds = [...fx.sessions().keys()]
    expect(sessionIds.length).toBe(2)
    expect(sessionIds[1]).not.toBe(firstSession)
    expect(fx.deleted().has(firstSession as string)).toBe(true)
    expect(fx.deleted().has(sessionIds[1] as string)).toBe(false)
    expect(client.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    const listAfter = fx.log().filter((e) => e.rpc === "tools/list")
    const retried = listAfter[listAfter.length - 1]
    expect(retried?.session).toBe(sessionIds[1])
    expect(retried?.protocol).toBe(LATEST_PROTOCOL_VERSION)
    expect(retried?.bearer).toBe("FRESH")
    expect(headers().Authorization).toBe("Bearer FRESH")
    expect(builds()).toBe(2)
    expect(provider.invals()).toBe(1)
    await client.stop()
  })

  test("handshake 401 does not recurse / deadlock", async () => {
    const failInit = new Set(["FRESH"])
    const fx = statefulHttp({ failInitializeFor: failInit })
    const provider = rotatingProvider()
    const { client } = makeClient(fx.fetchFn, provider)
    await client.start()
    const firstSession = [...fx.sessions().keys()][0] as string
    await expect(client.listTools()).rejects.toThrow(/401/)
    expect(fx.initializeCount()).toBe(1)
    expect(provider.invals()).toBe(1)
    expect(provider.asks()).toBe(2)
    expect(fx.deleted().has(firstSession)).toBe(false)
    failInit.delete("FRESH")
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(fx.deleted().has(firstSession)).toBe(true)
    await client.stop()
  })

  test("concurrent 401s single-flight; both listTools succeed", async () => {
    const fx = statefulHttp()
    const provider = rotatingProvider()
    const { client, builds } = makeClient(fx.fetchFn, provider)
    await client.start()
    const [a, b] = await Promise.all([client.listTools(), client.listTools()])
    expect(a.map((t) => t.name)).toEqual(["echo"])
    expect(b.map((t) => t.name)).toEqual(["echo"])
    expect(provider.invals()).toBe(1)
    expect(builds()).toBe(2)
    expect(fx.initializeCount()).toBe(2)
    await client.stop()
  })

  test("stop during refresh closes candidate and does not hang", async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => {
      release = r
    })
    const fx = statefulHttp()
    const provider = rotatingProvider({ hold: () => hold })
    const { client } = makeClient(fx.fetchFn, provider)
    await client.start()
    const pending = client.listTools()
    await new Promise((r) => setTimeout(r, 20))
    await client.stop()
    release()
    await expect(pending).rejects.toThrow()
  })

  test("tools/call 401 is NOT auto-replayed", async () => {
    const fx = statefulHttp()
    const provider = rotatingProvider()
    const { client } = makeClient(fx.fetchFn, provider)
    await client.start()
    await expect(client.callTool("echo", {})).rejects.toThrow(/401/)
    expect(fx.toolsCallCount()).toBe(1)
    expect(fx.initializeCount()).toBe(2)
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(fx.toolsCallCount()).toBe(1)
    await client.stop()
  })

  test("old close DELETE does not kill the adopted session", async () => {
    const fx = statefulHttp()
    const provider = rotatingProvider()
    const { client } = makeClient(fx.fetchFn, provider)
    await client.start()
    await client.listTools()
    const ids = [...fx.sessions().keys()]
    expect(ids.length).toBe(2)
    expect(fx.deleted().has(ids[0] as string)).toBe(true)
    expect(fx.deleted().has(ids[1] as string)).toBe(false)
    await client.stop()
    expect(fx.deleted().has(ids[1] as string)).toBe(true)
  })

  test("late ticks after reauth do not overwrite the published protocol pin", async () => {
    const fx = statefulHttp()
    const { client } = makeClient(fx.fetchFn, rotatingProvider())
    await client.start()
    await client.listTools()
    const pin = client.pinnedProtocolVersion()
    await new Promise((r) => setTimeout(r, 30))
    expect(client.pinnedProtocolVersion()).toBe(pin)
    expect(pin).toBe(LATEST_PROTOCOL_VERSION)
    const again = await client.listTools()
    expect(again.map((t) => t.name)).toEqual(["echo"])
    await client.stop()
  })

  test("replay allow-list: list/initialize yes, tools/call no", () => {
    expect(isReplayableAfterReauth("initialize")).toBe(true)
    expect(isReplayableAfterReauth("tools/list")).toBe(true)
    expect(isReplayableAfterReauth("resources/list")).toBe(true)
    expect(isReplayableAfterReauth("tools/call")).toBe(false)
    expect(isReplayableAfterReauth("resources/read")).toBe(false)
  })
})
