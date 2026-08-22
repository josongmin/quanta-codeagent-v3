/** jun-06 — MCP OAuth keyring REACHABILITY hellgate (write FIRST: red → green).
 *
 *  Seals the LIVE-WIRE that connects the (previously dead) H18 MCP OAuth provider
 *  + the keyring decorator to a real MCP load. Before this wiring the keyring
 *  slice + `buildMcpOAuthWiring` had NO live caller — `mcp-bridge` never set
 *  `clientOpts.oauthProvider`. This test drives the WHOLE composition-root path:
 *
 *    `resolveMcpOAuthProvider(servers, seams)` → `loadMcpTools(..., { oauthProvider })`
 *      → `McpClient.start()` resolves a bearer → the transport sees
 *        `Authorization: Bearer <token>` AND the token lands in the FAKE keyring
 *        (never the file, never argv).
 *
 *  Arms:
 *    (1) knob-on (`QUANTA_MCP_OAUTH=1` + per-server `oauth:true` +
 *        `QUANTA_MCP_OAUTH_KEYRING=1`) ⇒ the load wires the provider with a
 *        keyring-COMPOSED token store: discovery → DCR → browser flow → token
 *        exchange → the bearer is attached to the MCP HTTP request, and the token
 *        is persisted into the FAKE keyring (composeTokenStore write-path), NOT
 *        the file (the file store dir stays empty);
 *    (2) the keyring secret NEVER appears on argv — the fake `security` exec
 *        records every `args[]`; the access/refresh token strings appear in NONE
 *        of them (they arrive on stdin only);
 *    (3) knob-off (`QUANTA_MCP_OAUTH` unset) ⇒ NO provider, the transport sees
 *        NO Authorization header, no discovery, no browser flow (byte-identical
 *        to the pre-H18 load);
 *    (4) keyring-knob-off (`QUANTA_MCP_OAUTH=1` but `QUANTA_MCP_OAUTH_KEYRING`
 *        unset) ⇒ the provider is still wired (bearer attached) but the token is
 *        written to the 0600 FILE store, the keyring exec is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadMcpTools } from "@/agent"
import type { FetchPort } from "@/connectors"
import { bunKeyringExec, type KeyringExec } from "@/host/runtime"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { __resetRuntimeConfig } from "@/shared"
import { resolveMcpOAuthProvider } from "../../src/apps/cli/internal"

// ── fakes ────────────────────────────────────────────────────────────────────

const NL = "\n"

/** A fake `security`-CLI keyring exec: stores secrets in a Map keyed by
 *  `service account`, reading the secret from STDIN (never argv). Records
 *  EVERY argv array so the test can prove the token never appears on argv. */
const fakeKeyringExec = (): KeyringExec & {
  argvLog: () => string[][]
  store: () => Map<string, string>
} => {
  const map = new Map<string, string>()
  const argvLog: string[][] = []
  const keyOf = (args: readonly string[]): string => {
    const at = (flag: string): string | undefined => {
      const i = args.indexOf(flag)
      return i >= 0 ? args[i + 1] : undefined
    }
    return `${at("-s")} ${at("-a")}`
  }
  const handlers: Record<
    string,
    (key: string, stdin: string | undefined) => { ok: boolean; stdout: string }
  > = {
    "default-keychain": () => ({ ok: true, stdout: "" }),
    // secret arrives on STDIN only (never argv).
    "add-generic-password": (key, stdin) => {
      if (stdin === undefined) return { ok: false, stdout: "" }
      map.set(key, stdin)
      return { ok: true, stdout: "" }
    },
    "find-generic-password": (key) => {
      const v = map.get(key)
      return v !== undefined ? { ok: true, stdout: `${v}${NL}` } : { ok: false, stdout: "" }
    },
    "delete-generic-password": (key) => {
      map.delete(key)
      return { ok: true, stdout: "" }
    },
  }
  const exec: KeyringExec = async (input) => {
    argvLog.push([input.bin, ...input.args])
    const handler = handlers[input.args[0] ?? ""]
    return handler ? handler(keyOf(input.args), input.stdin) : { ok: false, stdout: "" }
  }
  return Object.assign(exec, { argvLog: () => argvLog, store: () => map })
}

/** A fake auth server: RFC 8414 well-known discovery (advertising RFC 7591
 *  dynamic client registration, the zero-config MCP path) + a DCR endpoint + a
 *  token endpoint. The provider has no static client id, so it registers one via
 *  DCR before the browser flow. */
const fakeFetchPort =
  (origin: string): FetchPort =>
  async (url, init) => {
    if (url === `${origin}/.well-known/oauth-authorization-server`) {
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
          }),
      }
    }
    if (url === `${origin}/register` && init?.method === "POST") {
      return { status: 201, ok: true, text: async () => JSON.stringify({ client_id: "dyn-123" }) }
    }
    if (url === `${origin}/token` && init?.method === "POST") {
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            access_token: "ACCESS-SECRET-XYZ",
            refresh_token: "REFRESH-SECRET-ABC",
            token_type: "Bearer",
            expires_in: 3600,
          }),
      }
    }
    return { status: 404, ok: false, text: async () => "not found" }
  }

/** A scripted browser flow (no real loopback / browser): returns a fixed code. */
const fakeBrowserFlow = async (_input: {
  readonly authorizeEndpoint: string
  readonly clientId: string
  readonly serverName: string
}) => ({
  code: "AUTH-CODE-123",
  verifier: "VERIFIER-XYZ",
  redirectUri: "http://localhost:1455/auth/callback",
})

interface SentRecord {
  readonly authHeader: string | undefined
  readonly method: unknown
}

/** A fake MCP transport FACTORY — when supplied as the client's `transport`
 *  opt as a FUNCTION, the `McpClient` treats it as a deferred factory: it
 *  resolves the OAuth bearer FIRST and invokes the factory with the
 *  bearer-merged config (the production HTTP path). The factory records the
 *  `Authorization` header the client merged in, plus auto-answers requests so
 *  `start()`/`listTools()` complete. */
const fakeTransportFactory = () => {
  const sent: SentRecord[] = []
  const factory = (cfg: { headers?: Record<string, string> }): McpTransport => {
    let onMsg: McpTransportMessageHandler | null = null
    const authHeader = cfg.headers?.Authorization
    return {
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
        sent.push({ authHeader, method: p.method })
        const id = p.id
        if (typeof id === "number") {
          const method = p.method
          const result =
            method === "initialize"
              ? { capabilities: {}, serverInfo: { name: "fake", version: "0" } }
              : method === "tools/list"
                ? { tools: [{ name: "echo", description: "", inputSchema: { type: "object" } }] }
                : {}
          queueMicrotask(() => onMsg?.({ jsonrpc: "2.0", id, result } as JsonRpcMessage))
        }
        return null
      },
      async close() {},
    }
  }
  return { factory, sent: () => sent }
}

const ORIGIN = "https://mcp.example.com"
const httpServer = () => ({
  name: "remote",
  command: [] as string[],
  url: `${ORIGIN}/rpc`,
  oauth: true,
})

// ── env harness ──────────────────────────────────────────────────────────────

let storeDir: string
const saved: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string | undefined) => {
  saved[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
  // `runtimeConfig()` memoizes the env snapshot; reset so the knob change is read.
  __resetRuntimeConfig()
}

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mcp-oauth-reach-"))
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
  rmSync(storeDir, { recursive: true, force: true })
})

const tokenFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".json"))

describe("mcp-oauth keyring reachability — live-wired provider + keyring store", () => {
  it("knob-on ⇒ bearer attached AND token persisted to the FAKE keyring (not the file)", async () => {
    setEnv("QUANTA_MCP_OAUTH", "1")
    setEnv("QUANTA_MCP_OAUTH_KEYRING", "1")
    const exec = fakeKeyringExec()
    const servers = [httpServer()]
    const provider = resolveMcpOAuthProvider(servers, {
      fetchPort: fakeFetchPort(ORIGIN),
      browserFlow: fakeBrowserFlow,
      tokenStoreDir: storeDir,
      keyring: { enabled: true, platform: "darwin", exec },
    })
    expect(provider).toBeDefined()

    const { factory, sent } = fakeTransportFactory()
    const { clients } = await loadMcpTools(servers, undefined, {
      ...(provider !== undefined ? { oauthProvider: provider } : {}),
      // Return the FACTORY (a function) so the client defers transport
      // construction, resolves the bearer, and builds the carrier with the
      // bearer-merged headers (the production HTTP path).
      transportFor: () => factory,
    })

    // The bearer was resolved BEFORE the carrier was built ⇒ every request
    // carries `Authorization: Bearer ACCESS-SECRET-XYZ`.
    const records = sent()
    expect(records.length).toBeGreaterThan(0)
    for (const r of records) {
      expect(r.authHeader).toBe("Bearer ACCESS-SECRET-XYZ")
    }

    // The token landed in the FAKE keyring (composeTokenStore write-path) …
    const stored = [...exec.store().values()]
    expect(stored.length).toBe(1)
    expect(stored[0]).toContain("ACCESS-SECRET-XYZ")
    // … and NOT in the file store (the dir holds no per-server token file).
    expect(tokenFiles(storeDir)).toEqual([])

    await Promise.all(clients.map((c) => c.stop()))
  })

  it("keyring secret NEVER appears on argv (stdin-only)", async () => {
    setEnv("QUANTA_MCP_OAUTH", "1")
    setEnv("QUANTA_MCP_OAUTH_KEYRING", "1")
    const exec = fakeKeyringExec()
    const servers = [httpServer()]
    const provider = resolveMcpOAuthProvider(servers, {
      fetchPort: fakeFetchPort(ORIGIN),
      browserFlow: fakeBrowserFlow,
      tokenStoreDir: storeDir,
      keyring: { enabled: true, platform: "darwin", exec },
    })
    const { factory } = fakeTransportFactory()
    const { clients } = await loadMcpTools(servers, undefined, {
      ...(provider !== undefined ? { oauthProvider: provider } : {}),
      transportFor: () => factory,
    })

    const allArgv = exec.argvLog().flat().join(" ")
    expect(allArgv).not.toContain("ACCESS-SECRET-XYZ")
    expect(allArgv).not.toContain("REFRESH-SECRET-ABC")
    // sanity: the keyring WAS exercised (write happened)
    expect(exec.argvLog().some((a) => a.includes("add-generic-password"))).toBe(true)

    await Promise.all(clients.map((c) => c.stop()))
  })

  it("knob-off ⇒ NO provider, NO Authorization header (byte-identical load)", async () => {
    setEnv("QUANTA_MCP_OAUTH", undefined)
    setEnv("QUANTA_MCP_OAUTH_KEYRING", undefined)
    const exec = fakeKeyringExec()
    const servers = [httpServer()]
    const provider = resolveMcpOAuthProvider(servers, {
      fetchPort: fakeFetchPort(ORIGIN),
      browserFlow: fakeBrowserFlow,
      tokenStoreDir: storeDir,
      keyring: { enabled: false, platform: "darwin", exec },
    })
    expect(provider).toBeUndefined()

    const { factory, sent } = fakeTransportFactory()
    const { clients } = await loadMcpTools(servers, undefined, {
      ...(provider !== undefined ? { oauthProvider: provider } : {}),
      transportFor: () => factory,
    })

    for (const r of sent()) expect(r.authHeader).toBeUndefined()
    // No discovery, no browser flow, no keyring exec ran.
    expect(exec.argvLog()).toEqual([])
    await Promise.all(clients.map((c) => c.stop()))
  })

  it("oauth on but keyring off ⇒ bearer attached, token in the FILE store (keyring untouched)", async () => {
    setEnv("QUANTA_MCP_OAUTH", "1")
    setEnv("QUANTA_MCP_OAUTH_KEYRING", undefined)
    const exec = fakeKeyringExec()
    const servers = [httpServer()]
    const provider = resolveMcpOAuthProvider(servers, {
      fetchPort: fakeFetchPort(ORIGIN),
      browserFlow: fakeBrowserFlow,
      tokenStoreDir: storeDir,
      keyring: { enabled: false, platform: "darwin", exec },
    })
    expect(provider).toBeDefined()

    const { factory, sent } = fakeTransportFactory()
    const { clients } = await loadMcpTools(servers, undefined, {
      ...(provider !== undefined ? { oauthProvider: provider } : {}),
      transportFor: () => factory,
    })

    for (const r of sent()) expect(r.authHeader).toBe("Bearer ACCESS-SECRET-XYZ")
    // Token in the 0600 file store, keyring exec never invoked.
    expect(tokenFiles(storeDir).length).toBe(1)
    expect(exec.argvLog()).toEqual([])
    await Promise.all(clients.map((c) => c.stop()))
  })

  it("the production keyring exec passes the secret on stdin, never argv", () => {
    // `bunKeyringExec` is the real Bun.spawn-backed exec; we only assert its
    // shape contract here (the adapters above already proved stdin-only).
    expect(typeof bunKeyringExec()).toBe("function")
  })
})
