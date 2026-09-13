import { spawn as spawnChild } from "node:child_process"
import { mkdir, readFile, realpath, unlink } from "node:fs/promises"
import { join as joinPath } from "node:path"
import type { ElicitationPrompterFactory, McpReloadableSource, SamplingWiringInput } from "@/agent"
import { applyMcpClientWiring, loadMcpTools, type McpStoppable } from "@/agent"
import { isWorkspaceTrusted, untrustedWorkspaceMessage } from "@/agent/workspace-trust"
import {
  createCliOAuthCallback,
  deriveChallengeS256,
  generateCodeVerifier,
  generateState,
  resolveQuantaHome,
} from "@/auth/chatgpt-oauth"
import { writePrivateFileAtomic } from "@/auth/private-file-atomic"
import {
  canonicalizeTrustedPaths,
  filterMcpServersByPolicy,
  type McpLaunchPolicy,
  mergeDiskLayers,
  osManagedSettingsPath,
  parseSettingSources,
  readDiskLayers,
  type TrustRecord,
  TrustStore,
} from "@/config"
import type { FetchPort, TokenRecord, TokenStorePort } from "@/connectors"
import {
  buildMcpOAuthWiring,
  buildRootsWiring,
  buildSamplingWiring,
  type McpBrowserFlowResult,
  type McpOAuthDeps,
  type McpToolReloadController,
  pickMcpNegotiator,
  resolveMcpOAuthKeyringOption,
} from "@/host/runtime"
import type { LLMPort } from "@/llm"
import {
  type CapabilityNegotiator,
  DEFAULT_BACKOFF_POLICY,
  type ElicitationPrompter,
  isolatedMcpEnabledFromEnv,
  McpClient,
  type McpClientTransport,
  type McpOAuthProviderPort,
  type McpResourceObserver,
  type McpServerConfig,
  type RootsProviderPort,
  type SamplingHandlerPort,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import type { Metrics, StructuredLogger } from "@/observability"
import { parseEnvFlag } from "@/runner/assemble"
import type { ProxyEnvInput } from "@/runtime/network-proxy"
import { emitOperatorNotice, errMessage, logger, quantaHomeDir, runtimeConfig } from "@/shared"
import { MCPRootSchema, PLUGIN_MCP_FILE } from "@/skill/plugin-manifest"
import {
  type McpResourceCaptureHolder,
  mcpResourcesTools,
  type ResourcesHandle,
  type Tool,
} from "@/tool"
import type { McpHealthHolder } from "./mcp-health"

/**
 * ADR-0024 split — the CLI's MCP plumbing (auto-restart supervisor deps, the
 * connectors-backed OAuth provider assembly, config-path / config-read /
 * launch-policy resolution, and the advertise-iff-able inbound-capability
 * wiring + `loadMcpTools` opts assembly). Extracted from `internal.ts`;
 * re-exported from `../internal` so existing importers keep resolving them from
 * `./internal`. `loadFeatures` (the orchestrator) stays in `internal.ts` and
 * consumes these building blocks.
 */

/** MCP crash-detection + auto-restart (ADR-0435). Default-OFF: when unset,
 *  `loadMcpTools` runs the single-client path and MCP behavior is
 *  byte-identical. `QUANTA_MCP_AUTORESTART=1` wraps every server in a
 *  {@link McpReconnectSupervisor} (2-phase exponential backoff + full-jitter,
 *  stability reset, storm cap → DEGRADED). */
export const mcpAutoRestartEnabled = (): boolean =>
  parseEnvFlag(process.env.QUANTA_MCP_AUTORESTART, false)

/** RFC04-2/3 — MCP tool hot-reload gate. Default-OFF: when unset (the default),
 *  `loadFeatures` wires NO reload observer + collects NO reload sources, the CLI
 *  `buildTooling` sets no `exposeRebuild`, and the composition root builds no
 *  controller / snapshot ref — so `session-bootstrap` rebuilds the turn snapshot
 *  from `cfg.registry` exactly as today (byte-identical). `QUANTA_MCP_HOT_RELOAD=1`
 *  activates the LIVE feeder: a non-supervised server's `tools/list_changed`
 *  republishes the turn capability snapshot at the NEXT turn boundary. Read here
 *  (composition root) via `parseEnvFlag` — NOT through `runtimeConfigFromEnv` —
 *  mirroring `QUANTA_MCP_AUTORESTART`; declared in `@/config/knob-inventory`. */
export const mcpHotReloadEnabled = (): boolean =>
  parseEnvFlag(process.env.QUANTA_MCP_HOT_RELOAD, false)

/** Build the injected {@link SupervisorDeps} for one MCP server. The real
 *  clock/timer/RNG are injected ONLY here, at the composition root — the
 *  supervisor core itself never reaches for a global. The factory picks
 *  `McpClient`. The host-resolved `MCP_USE_ISOLATED_SPAWN` policy is injected
 *  into each client and selects `IsolatedMcpTransport` (`process-ready`) for
 *  command servers.
 *  HTTP/url is unchanged. Do not construct `IsolatedMcpClient` here.
 *
 *  B1 + H19 — the inbound-capability wiring bundle (`{ negotiator, handler?,
 *  rootsProvider? }`) is BAKED into the restart factory via the SAME
 *  `applyMcpClientWiring` helper the single-client path uses, so the supervisor —
 *  which owns the lifecycle, not the policy — re-applies it to EVERY (re)connected
 *  client. A reconnected client therefore re-advertises `sampling`/`roots` and
 *  re-handles inbound `sampling/createMessage` + `roots/list`. Absent ⇒ a vanilla
 *  `new McpClient(c)` (byte-identical to the pre-wire supervised path).
 *
 *  `transportFor` is the optional test seam (mirrors the single-client path) so a
 *  supervised client can be driven by a scripted transport without a real spawn;
 *  production omits it (the client builds its default carrier). */
const mcpSupervisorDepsFor = (
  slog: StructuredLogger,
  wiring: SamplingWiringInput | undefined,
  transportFor: ((config: McpServerConfig) => McpClientTransport) | undefined,
  oauthProvider: McpOAuthProviderPort | undefined,
  proxyEnv: ProxyEnvInput | undefined,
  resourceObserver: McpResourceObserver | undefined,
  isolatedSpawn: boolean,
) => {
  return (_config: McpServerConfig): SupervisorDeps => ({
    factory: (c): SupervisableMcpClient => {
      const clientOpts: NonNullable<ConstructorParameters<typeof McpClient>[1]> = {}
      if (transportFor !== undefined) clientOpts.transport = transportFor(c)
      if (isolatedSpawn) clientOpts.isolatedSpawn = true
      // H18 (jun-06 live-wire) — bake the OAuth provider into the restart factory
      // via the SAME helper the single-client path uses, so a reconnected client
      // RE-resolves a bearer for an `oauth:true` server. Absent ⇒ headless
      // rejecter (byte-identical to the pre-wire supervised path).
      // H3 (jun-10) — `proxyEnv` rides the same helper so a RECONNECTED MCP server
      // child re-injects the session egress proxy (the bypass cannot reopen on a
      // restart). Absent ⇒ no keys (byte-identical).
      // RFC04-2/3 — the reload observer rides the same helper so a RECONNECTED
      // client re-subscribes its `tools/list_changed` to the SAME controller.
      // Absent ⇒ no observer (byte-identical).
      applyMcpClientWiring(clientOpts, wiring, oauthProvider, proxyEnv, resourceObserver)
      return new McpClient(c, clientOpts)
    },
    policy: DEFAULT_BACKOFF_POLICY,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
    onStateChange: (s) =>
      slog.info("mcp.supervisor.state", { server: s.serverName, state: s.state }),
  })
}

// ── H18 (jun-06) — live-wire the MCP OAuth provider at the composition root ──
//
// The keyring slice + `buildMcpOAuthWiring` + `resolveMcpOAuthKeyringOption`
// were sealed but had NO LIVE CALLER (the bridge never set
// `clientOpts.oauthProvider`). The block below assembles the connectors-backed
// provider — file token store (0600) + injected fetch/clock/browser-flow/issuer
// — and threads it (with the keyring composition baked into its token store)
// into BOTH MCP-load paths. Default-OFF: `QUANTA_MCP_OAUTH` unset ⇒
// `buildMcpOAuthWiring` returns `{ provider: undefined }` ⇒ no provider wired ⇒
// byte-identical to today's no-auth load.

/** A file-backed, multi-server `TokenStorePort` (one 0600 JSON file per server
 *  under `<quanta-home>/mcp-oauth/`). This is the H18 default token store the
 *  keyring DECORATOR (`composeTokenStore`) wraps when
 *  `QUANTA_MCP_OAUTH_KEYRING=1`; OFF ⇒ it is used directly (byte-identical to
 *  the documented "0600 file by default" H18 store). Tokens are NEVER logged —
 *  they live only in the 0600 file and the in-memory record. NO-THROW reads
 *  (a corrupt/absent file ⇒ `undefined` ⇒ the provider re-auths) so a bad file
 *  never crashes the MCP load. */
export const createFileMcpTokenStore = (dir: string): TokenStorePort => {
  const safe = (id: string): string => id.replace(/[^A-Za-z0-9_.-]+/g, "_")
  const fileFor = (id: string): string => joinPath(dir, `${safe(id)}.json`)
  return {
    async read(id: string): Promise<TokenRecord | undefined> {
      try {
        const raw = await readFile(fileFor(id), "utf8")
        const parsed = JSON.parse(raw) as unknown
        if (parsed === null || typeof parsed !== "object") return undefined
        const o = parsed as Record<string, unknown>
        if (typeof o.accessToken !== "string" || typeof o.tokenType !== "string") return undefined
        return o as unknown as TokenRecord
      } catch (e) {
        // Absent / unreadable / malformed ⇒ treat as "no token" (re-auth path).
        logger.warn("mcp OAuth token read failed; treating token as absent", {
          error: errMessage(e),
          id,
        })
        return undefined
      }
    },
    async write(id: string, record: TokenRecord): Promise<void> {
      await mkdir(dir, { recursive: true })
      await writePrivateFileAtomic(fileFor(id), `${JSON.stringify(record)}\n`)
    },
    async delete(id: string): Promise<void> {
      try {
        await unlink(fileFor(id))
      } catch (e) {
        // Idempotent — an absent file is fine.
        logger.warn("mcp OAuth token delete failed", { error: errMessage(e), id })
      }
    },
  }
}

/** The production `FetchPort` for OAuth discovery / DCR / token exchange: a thin
 *  shape adapter over `globalThis.fetch` (read at the root only). */
const realMcpFetchPort: FetchPort = async (url, init) => {
  const res = await fetch(url, {
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(init?.headers !== undefined ? { headers: init.headers as Record<string, string> } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  })
  return { status: res.status, ok: res.ok, text: () => res.text() }
}

/** A generic RFC 6749 §4.1 authorization-code + PKCE browser flow for an MCP
 *  server, REUSING the surface-agnostic loopback callback receiver
 *  (`createCliOAuthCallback`, the SAME seam the chatgpt-oauth `/login` flow uses)
 *  and the chatgpt-oauth PKCE helpers. It builds a STANDARD authorize URL
 *  against the DISCOVERED `authorizeEndpoint` (not the OpenAI-specific URL that
 *  `runBrowserFlow` hard-codes), so it works against any RFC-8414 issuer the H18
 *  provider discovered. Returns `{ code, verifier, redirectUri }` for the host
 *  provider to exchange (the exchange + refresh live in the connectors-backed
 *  provider; this only obtains the code). The authorization code is NEVER
 *  logged. */
const runMcpBrowserFlow = async (input: {
  readonly authorizeEndpoint: string
  readonly clientId: string
  readonly serverName: string
}): Promise<McpBrowserFlowResult> => {
  const verifier = generateCodeVerifier()
  const challenge = deriveChallengeS256(verifier)
  const state = generateState()
  const callback = createCliOAuthCallback()
  const handle = await callback.start({ expectedState: state })
  const url = new URL(input.authorizeEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", handle.redirectUri)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  logger.info("mcp-oauth: opening browser for authorization", { server: input.serverName })
  // Open the user's browser (best-effort — a headless box can paste the URL the
  // callback receiver printed). Failure to open is non-fatal; the loopback
  // receiver still awaits the redirect.
  try {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawnChild(opener, [url.toString()], { stdio: "ignore", detached: true }).unref()
  } catch (e) {
    // Opener unavailable ⇒ the receiver's printed URL is the fallback.
    logger.warn("mcp OAuth browser opener unavailable; use the printed URL", {
      error: errMessage(e),
    })
  }
  const result = await handle.received
  return { code: result.code, verifier, redirectUri: handle.redirectUri }
}

/** Resolve the per-server OAuth issuer from its config `url` origin (the
 *  standard MCP pattern: RFC 8414 discovery runs against the resource server's
 *  origin). A server without a `url` (stdio carrier) or without `oauth:true`
 *  yields `undefined` ⇒ the provider obtains no token for it (unauthenticated). */
const mcpIssuerResolver =
  (servers: ReadonlyArray<McpServerConfig>) =>
  (serverName: string): string | undefined => {
    const server = servers.find((s) => s.name === serverName)
    if (server?.oauth !== true || server.url === undefined) return undefined
    try {
      return new URL(server.url).origin
    } catch (e) {
      logger.warn("mcp OAuth server URL is malformed", { error: errMessage(e), serverName })
      return undefined
    }
  }

/** H18 (jun-06) — assemble the connectors-backed `McpOAuthProviderPort` for the
 *  CLI MCP load, or `undefined` when OFF. `buildMcpOAuthWiring` is the single
 *  gate: it returns a provider ONLY when `QUANTA_MCP_OAUTH=1` AND deps are
 *  present (the per-server `oauth:true` flag is the second gate, applied inside
 *  the `McpClient`). The keyring composition (`QUANTA_MCP_OAUTH_KEYRING`) is
 *  resolved here via `resolveMcpOAuthKeyringOption()` (the ONLY `process.platform`
 *  read for the keyring decision) and BAKED into the provider's token store, so
 *  the bridge never reaches for the keyring. When NO server opts into `oauth`,
 *  the deps are omitted ⇒ no provider (byte-identical, no file store created).
 *
 *  `opts.fetchPort` / `opts.browserFlow` / `opts.tokenStoreDir` / `opts.keyring`
 *  are test seams (inject a fake auth server + scripted browser flow + a tmp
 *  store dir + a fake-exec keyring option); production omits them. */
export const resolveMcpOAuthProvider = (
  servers: ReadonlyArray<McpServerConfig>,
  opts: {
    readonly fetchPort?: FetchPort
    readonly browserFlow?: typeof runMcpBrowserFlow
    readonly tokenStoreDir?: string
    readonly keyring?: ReturnType<typeof resolveMcpOAuthKeyringOption>
  } = {},
): McpOAuthProviderPort | undefined => {
  const enabled = runtimeConfig().mcpOAuth
  // Cheap short-circuit: no server opts into OAuth ⇒ no deps ⇒ no provider, and
  // crucially no file store directory created (byte-identical when the knob is
  // on but unused). Still routes through the gate so the OFF path is the
  // documented single decision point (returns `{ provider: undefined }`).
  const anyOAuth = servers.some((s) => s.oauth === true && s.url !== undefined)
  if (!enabled || !anyOAuth) return buildMcpOAuthWiring(enabled, undefined).provider
  const dir = opts.tokenStoreDir ?? joinPath(resolveQuantaHome(process.env), "mcp-oauth")
  const deps: McpOAuthDeps = {
    fetchPort: opts.fetchPort ?? realMcpFetchPort,
    tokenStore: createFileMcpTokenStore(dir),
    clockPort: { now: () => Date.now() },
    runBrowserFlow: opts.browserFlow ?? runMcpBrowserFlow,
    issuerFor: mcpIssuerResolver(servers),
  }
  return buildMcpOAuthWiring(enabled, deps, opts.keyring ?? resolveMcpOAuthKeyringOption()).provider
}

/** MCP config path resolver. Supports the legacy wrapper file
 *  (`QUANTA_MCP_CONFIG`) and the thinner browser/plugin bridge:
 *    - `QUANTA_BROWSER_MCP_CONFIG` → direct path to a plugin-style `.mcp.json`
 *    - `QUANTA_BROWSER_MCP_PLUGIN_DIR` → plugin root; we append `/.mcp.json`
 *  Precedence is explicit config first so existing callers stay byte-identical. */
export const resolveMcpConfigPath = (
  envSource: NodeJS.ProcessEnv = process.env,
  // §17 packet F1b — the PROJECT root. Supplied ⇒ the resolver falls back to
  // `<cwd>/.mcp.json`, which is the file the connector installer writes when no
  // env override is set (`gated-tool-ports.ts`).
  //
  // Without this the writer and the reader disagreed about which file IS the
  // config: an install wrote `<cwd>/.mcp.json` and the next launch resolved
  // `undefined`, whereupon `readMcpConfig` returns `[]`. The connector silently
  // did not exist. "Install" has to round-trip or it is a lie.
  //
  // Omitted ⇒ `undefined` exactly as before, so callers that have no project
  // root (and every existing call site that passes only the env) are unchanged.
  projectRoot?: string,
): string | undefined => {
  const explicit = envSource.QUANTA_MCP_CONFIG?.trim()
  if (explicit) return explicit
  const browserConfig = envSource.QUANTA_BROWSER_MCP_CONFIG?.trim()
  if (browserConfig) return browserConfig
  const browserPluginDir = envSource.QUANTA_BROWSER_MCP_PLUGIN_DIR?.trim()
  if (browserPluginDir) return `${browserPluginDir.replace(/\/+$/, "")}/${PLUGIN_MCP_FILE}`
  if (projectRoot !== undefined) return joinPath(projectRoot, PLUGIN_MCP_FILE)
  return undefined
}

const pluginSpecToServerConfig = (
  name: string,
  spec: {
    command?: string | undefined
    args?: string[] | undefined
    env?: Record<string, string> | undefined
    url?: string | undefined
    headers?: Record<string, string> | undefined
    oauth?: boolean | undefined
  },
): McpServerConfig => ({
  name,
  // command/args are optional (http servers omit them); an absent or empty
  // command yields the empty argv the http carrier selection keys off.
  command:
    spec.command !== undefined && spec.command.length > 0
      ? [spec.command, ...(spec.args ?? [])]
      : [],
  ...(spec.env !== undefined ? { env: spec.env } : {}),
  ...(spec.url !== undefined ? { url: spec.url } : {}),
  ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
  // H18 — carry the per-server OAuth opt-in through so `mcpIssuerResolver` /
  // `mcpOAuthProviderFromConnectors` (which gate on `oauth === true`) activate
  // the bearer flow. Dropped here ⇒ an http OAuth server would never authenticate.
  ...(spec.oauth === true ? { oauth: true } : {}),
})

/** Read MCP server configs from a config file. Accepts BOTH:
 *    - CLI wrapper format: `{ "servers": [{ "name": "...", "command": ["..."] }] }`
 *    - plugin/browser format: `{ "mcpServers": { "browser": { "command": "...", "args": [...] } } }`
 *  OFF when no resolver yields a path. */
export const readMcpConfig = async (
  slog: StructuredLogger,
  envSource: NodeJS.ProcessEnv = process.env,
  // §12.4 LIVE-wire — central-config MCP launch policy (E2 denylist + E1-sub
  // managed-only enforcement). `undefined` ⇒ no filtering (legacy byte-identical:
  // the gate-OFF path and the no-policy-configured path both pass undefined).
  policy?: McpLaunchPolicy,
  // §17 packet F1b — the project root, so a `.mcp.json` written by the connector
  // installer with no env override is actually READ on the next launch. Omitted
  // ⇒ env-only resolution exactly as before.
  projectRoot?: string,
): Promise<McpServerConfig[]> => {
  // Observable governance: every dropped server is slog'd — never a silent
  // disappearance the operator can't diagnose.
  const applyPolicy = (servers: McpServerConfig[]): McpServerConfig[] => {
    if (policy === undefined) return servers
    const { kept, dropped } = filterMcpServersByPolicy(servers, policy)
    for (const d of dropped)
      slog.warn("mcp.governance.dropped", { server: d.name, reason: d.reason })
    return [...kept]
  }
  // UUX-4-14 — `/mcp disable <server>` writes `disabled: true` into THIS file
  // (write-through SSOT); the loader honors it here for BOTH formats. Skips
  // are slog'd (observable governance — never a silent disappearance).
  const dropDisabled = <T>(
    entries: readonly (readonly [string, T])[],
  ): readonly (readonly [string, T])[] =>
    entries.filter(([name, spec]) => {
      const off = (spec as { disabled?: unknown }).disabled === true
      if (off) slog.info("mcp.config.disabled", { server: name })
      return !off
    })
  const path = resolveMcpConfigPath(envSource, projectRoot)
  if (!path) return []
  // A path the operator named (QUANTA_MCP_CONFIG / the browser plugin knobs) is their
  // config. The project fallback is `<project>/.mcp.json`, a file that arrives with a
  // clone and names commands to spawn, so it loads only in a trusted folder — the design
  // this function had before the fallback existed ("never auto-loaded from the tree").
  if (
    projectRoot !== undefined &&
    resolveMcpConfigPath(envSource) === undefined &&
    !isWorkspaceTrusted(projectRoot)
  ) {
    if (await Bun.file(path).exists()) {
      slog.warn("mcp.project.untrusted", { path })
      emitOperatorNotice({
        severity: "warn",
        source: "mcp",
        message: untrustedWorkspaceMessage(`The MCP servers in ${path}`, projectRoot),
        hint: "no project MCP server was started",
      })
    }
    return []
  }
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as unknown
    const pluginStyle = MCPRootSchema.safeParse(parsed)
    if (pluginStyle.success) {
      return applyPolicy(
        dropDisabled(Object.entries(pluginStyle.data.mcpServers)).map(([name, spec]) =>
          pluginSpecToServerConfig(name, spec),
        ),
      )
    }
    const legacy = parsed as { servers?: McpServerConfig[] }
    if (Array.isArray(legacy.servers)) {
      return applyPolicy(
        dropDisabled(legacy.servers.map((s) => [s.name, s] as const)).map(([, s]) => s),
      )
    }
    slog.warn("mcp.config.error", {
      path,
      error: "expected {servers:[...]} or {mcpServers:{...}}",
    })
    return []
  } catch (e) {
    slog.warn("mcp.config.error", { path, error: errMessage(e) })
    return []
  }
}

/** §12.4 LIVE-wire — resolve the central-config MCP launch policy at the CLI
 *  composition root. NON-INTERACTIVE mirror of the hooks path in
 *  `apps/agent/index.ts#resolveCommandHookBindings` (same trust inputs:
 *  `~/.quanta/trust.json` + `QUANTA_TRUSTED_PATHS`; NO trust prompt — MCP load
 *  must never block boot on stdin; the hooks path owns interactive elevation).
 *
 *  Returns `undefined` (⇒ no filtering, legacy byte-identical) when:
 *    - `runtimeConfig().centralConfig` is OFF (strict default-OFF), or
 *    - resolution succeeded but NO layer configured `mcp.enabledServers` /
 *      `mcp.deniedServers` (avoids the behavior cliff: enabling central-config
 *      without MCP policy keeps existing `.mcp.json` servers untouched), or
 *    - resolution faulted (FAIL-SOFT availability: a corrupt local settings
 *      file must not kill every MCP server; the fault is slog'd). */
export const resolveMcpLaunchPolicy = async (
  slog: StructuredLogger,
  envSource: NodeJS.ProcessEnv = process.env,
): Promise<McpLaunchPolicy | undefined> => {
  const rc = runtimeConfig()
  if (!rc.centralConfig) return undefined
  try {
    let realCwd: string
    try {
      realCwd = await realpath(process.cwd())
    } catch (e) {
      logger.warn("mcp trust cwd realpath failed; using unresolved cwd", { error: errMessage(e) })
      realCwd = process.cwd()
    }
    const userConfigDir = quantaHomeDir()
    // Read-only trust persistence: `save` is a no-op — this path NEVER grants
    // trust (no prompt), it only honors grants the hooks flow / user persisted.
    const trustFile = joinPath(userConfigDir, "trust.json")
    const store = await TrustStore.load({
      load: async () => {
        try {
          const text = await readFile(trustFile, "utf8")
          const parsed = JSON.parse(text) as unknown
          return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, TrustRecord>)
            : undefined
        } catch (e) {
          logger.warn("mcp trust store read failed; treating grants as absent", {
            error: errMessage(e),
            path: trustFile,
          })
          return undefined
        }
      },
      commit: async () => {},
    })
    const trustedFromEnv = canonicalizeTrustedPaths(
      (rc.trustedPaths ?? "").split(",").map((s) => s.trim()),
    )
    const trusted = store.isTrusted(realCwd) || trustedFromEnv.has(realCwd)
    const layers = await readDiskLayers({
      cwd: realCwd,
      userConfigDir,
      managedPath: osManagedSettingsPath(
        process.platform,
        rc.managedSettingsPath,
        envSource.PROGRAMDATA,
      ),
      trusted,
      sources: parseSettingSources(rc.centralConfigSources),
      read: async (p: string) => {
        try {
          return await readFile(p, "utf8")
        } catch (e) {
          // ENOENT/EACCES/… ⇒ layer absent (fail-soft, same posture as the
          // hooks path's fsReadText).
          logger.warn("mcp settings layer read failed; treating layer as absent", {
            error: errMessage(e),
            path: p,
          })
          return undefined
        }
      },
      warn: (m: string) => slog.warn("mcp.governance.layer", { warn: m }),
    })
    const resolved = mergeDiskLayers(layers, trusted)
    if (resolved.mcpEnabledServers.length === 0 && resolved.mcpDeniedServers.length === 0) {
      return undefined
    }
    return {
      enabledServers: resolved.mcpEnabledServers,
      deniedServers: resolved.mcpDeniedServers,
    }
  } catch (e) {
    slog.warn("mcp.governance.resolve_failed", { error: errMessage(e) })
    return undefined
  }
}

export interface Features {
  planMode: boolean
  metrics: Metrics | undefined
  state: string | undefined
  resume: string | undefined
  mcpTools: Tool[]
  /** Stoppable handles for every loaded server. Without auto-restart these are
   *  `McpClient` instances; with `QUANTA_MCP_AUTORESTART=1` (ADR-0435) they are
   *  `McpReconnectSupervisor` instances — both expose a compatible `stop()`. */
  mcpClients: McpStoppable[]
  /** Raw configs from `QUANTA_MCP_CONFIG` — the SSOT for the `/mcp` slash
   *  command. `loadMcpTools` drops failed entries from `mcpClients`, so
   *  this is the only place where the surface can see all configured
   *  servers (incl. those that failed to spawn). */
  mcpConfigs: McpServerConfig[]
  lspTools: Tool[]
  /** ADR-0015: LSP nav tools (8). Default-OFF; appended to registry
   *  when `QUANTA_LSP_TOOLS=full`. */
  lspNavTools: Tool[]
  /** ADR-0016: first-class git tools (4). Default-OFF; appended to
   *  registry when `QUANTA_GIT_TOOLS=1`. */
  gitToolList: Tool[]
  /** Structural AST search via ast-grep (`QUANTA_AST_GREP=1`). Default-OFF;
   *  appended to extraTools when the gate is on. */
  astGrepTools: Tool[]
  /** B4 (jul-04 CLI-surfacing) — the SAME bounded capture holder the
   *  `mcp_read_resource_dir` / `mcp_read_resource` tools write each fetch into
   *  (present iff `QUANTA_MCP_RESOURCES` is on AND a capable server produced a
   *  live `ResourcesHandle`). The surface reads this to wire `/mcp-resources`
   *  over the EXACT ring the tools write into (one holder, both consumers — the
   *  surface-mints→down-thread contract). Absent ⇒ the tools were not registered
   *  ⇒ `/mcp-resources` stays "not wired" (byte-identical default-OFF).
   *
   *  The host bootstrap forwards `Features` opaquely as `BootstrapFeatures`, so
   *  the surface narrows `boot.features` back to this CLI shape at the setup seam
   *  to read the holder (mirrors the `mcpClients` narrow). */
  mcpResourceCapture?: McpResourceCaptureHolder
  /** WS-G (UUX-6-22) — the live MCP server-health registry the load callbacks
   *  (`onServerExit` / `onServerLoadError`) write into. The surface narrows it
   *  back at the setup seam (mirrors `mcpResourceCapture`) so the lifecycle
   *  pill re-derives per flush with the down overlay. Absent ⇒ no MCP servers
   *  configured (pill boot behavior byte-identical). */
  mcpHealth?: McpHealthHolder
  /** RFC04-2/3 (hot-reload) — the per-(non-supervised)-server reload sources the
   *  `onReloadSource` sink collected during `loadMcpTools`, present ONLY when
   *  `QUANTA_MCP_HOT_RELOAD` is on. The composition root feeds these into the
   *  reload controller's ALL-SOURCE relist. Absent ⇒ gate off / no eligible
   *  server ⇒ no controller (byte-identical). */
  mcpReloadSources?: McpReloadableSource[]
  /** RFC04-2/3 (hot-reload) — late-bind the reload controller into the observer
   *  wired at load time (the observer→controller edge is chicken-and-egg: the
   *  observer must exist BEFORE `loadMcpTools`, the controller AFTER the registry
   *  is built). The composition root calls this ONCE with the built controller so
   *  a live `tools/list_changed` reaches `requestReload`. Present iff
   *  {@link mcpReloadSources} is (same gate); absent ⇒ byte-identical. */
  bindMcpReloadController?: (controller: McpToolReloadController) => void
}

/** B1 (jun-04) — the stable elicitation-lease context id the inbound-sampling
 *  consent prompt binds to. Distinct from any real MCP `serverId` so a sampling
 *  consent prompt never coalesces with a server's own `elicitation/create`
 *  prompt. (The `__` prefix is not a legal MCP server name, so no collision.) */
const SAMPLING_CONSENT_CONTEXT = "__sampling_consent__"

/** B1 (jun-04) — build the OPTIONAL injectable seams for {@link loadFeatures}. */
export interface LoadFeaturesOpts {
  /** The assembled `LLMPort` an inbound `sampling/createMessage` delegates to.
   *  Threaded from the host bootstrap (`finalLLM`), which builds it just before
   *  it calls `loadFeatures`. Absent ⇒ inbound sampling is impossible regardless
   *  of the knob (no LLM to spend ⇒ `buildSamplingWiring` returns OFF). */
  readonly llm?: LLMPort
  /** Test seam — inject a per-server transport factory (mirrors `McpClient`'s
   *  `transport` option) so the e2e can drive the constructed client's inbound
   *  path without spawning a real process. Production omits it. */
  readonly mcpTransportFor?: (config: McpServerConfig) => McpClientTransport
  /** Test seam — force the elicitation prompter factory interactive (mirrors
   *  {@link buildCliElicitationPrompterFactory}'s `interactive` override) so the
   *  consent prompter + sampling wiring are exercised without a real TTY.
   *  Production omits it (the factory reads `process.stdin.isTTY`). */
  readonly elicitationPrompterFor?: ElicitationPrompterFactory
  /** H18 (jun-06 live-wire) — test seam for the MCP OAuth provider assembly: a
   *  fake auth-server `fetchPort`, a scripted `browserFlow`, a tmp
   *  `tokenStoreDir`, and a fake-exec `keyring` option. Forwarded verbatim to
   *  {@link resolveMcpOAuthProvider}. Production omits it (real `globalThis.fetch`,
   *  loopback browser flow, `<quanta-home>/mcp-oauth/`, live keyring). */
  readonly mcpOAuthDeps?: Parameters<typeof resolveMcpOAuthProvider>[1]
  /** H3 (jun-10 session-scoped egress) — the SESSION-SCOPED egress proxy env the
   *  host bootstrap opened (`openSessionEgressProxy`) BEFORE this call, live for
   *  the whole session. Threaded DOWN to `loadMcpTools` so every stdio MCP server
   *  child's own sockets are forced through the loopback allowlist (closing the
   *  bypass per-turn `withEgressProxy` cannot — an MCP child outlives a turn).
   *  Absent / proxy OFF ⇒ `{}` ⇒ no proxy keys injected (byte-identical load). */
  readonly proxyEnv?: ProxyEnvInput
}

/** B1 + H19 (jun-04) — the unified MCP inbound-capability wiring bundle the
 *  surface hands DOWN to `loadMcpTools` (consumed IDENTICALLY by the
 *  single-client and the supervised path). Mirrors `@/agent`'s
 *  `SamplingWiringInput`: ONE negotiator reflecting BOTH sampling AND roots, plus
 *  the answering ports — each present IFF its capability is advertised. */
type McpInboundWiring = {
  negotiator: CapabilityNegotiator
  handler?: SamplingHandlerPort
  rootsProvider?: RootsProviderPort
}

/** B1 + H19 (jun-04) — compute the advertise-iff-able inbound-capability wiring
 *  for the CLI MCP load, unifying sampling (B1) and roots (H19) into ONE bundle.
 *  The DECISION lives HERE (the surface), not in `@/agent/mcp-bridge` (which
 *  stays a pure consumer and never imports `@/host`): only the surface has the
 *  assembled `LLMPort`, the interactive consent prompter, AND the workspace cwd.
 *
 *  Two INDEPENDENT advertise-iff-able gates, each returning its `advertise` flag
 *  and the answering port from the SAME branch so they can never drift:
 *   - sampling (`buildSamplingWiring`): ON iff `QUANTA_MCP_SAMPLING=1` AND an LLM
 *     AND an interactive consent prompter (a remote server must never silently
 *     spend inference unattended);
 *   - roots (`buildRootsWiring`): ON iff `QUANTA_MCP_ROOTS=1` (the provider is the
 *     workspace cwd — always available, no extra dep).
 *
 *  The negotiator is computed ONCE from BOTH advertise flags, then VERIFIED
 *  against its compiled record so we NEVER advertise a capability we would
 *  answer with `-32601` (the base `QUANTA_MCP_CAPS=full` must be on for ANY
 *  inbound capability — `pickMcpNegotiator` returns the `{}` default otherwise,
 *  in which case both flags collapse to OFF). Returns `undefined` (⇒ the load is
 *  byte-identical) when NEITHER capability ends up advertised. */
export const resolveMcpInboundWiring = (
  llm: LLMPort | undefined,
  elicitationPrompterFor: ElicitationPrompterFactory | undefined,
): McpInboundWiring | undefined => {
  // --- sampling gate (B1) ---
  const consent: ElicitationPrompter | undefined =
    elicitationPrompterFor !== undefined
      ? elicitationPrompterFor(SAMPLING_CONSENT_CONTEXT)
      : undefined
  const samplingDeps = llm !== undefined && consent !== undefined ? { llm, consent } : undefined
  const sampling = buildSamplingWiring(runtimeConfig().mcpSampling, samplingDeps)

  // --- roots gate (H19) — provider is the session workspace cwd ---
  const roots = buildRootsWiring(runtimeConfig().mcpRoots, process.cwd())

  // The negotiator reflects BOTH capabilities, computed ONCE. `pickMcpNegotiator`
  // only advertises either under `QUANTA_MCP_CAPS=full`; absent ⇒ the `{}`
  // default ⇒ neither is advertised (both flags collapse to OFF below).
  const negotiator = pickMcpNegotiator(process.env, {
    ...(sampling.advertise ? { sampling: true } : {}),
    ...(roots.advertise ? { roots: true } : {}),
  })
  const compiled = negotiator.compile()
  // VERIFY each handler/provider against the compiled record so a handler/
  // provider is wired IFF the negotiator will actually advertise it (guards the
  // inverse drift: `QUANTA_MCP_SAMPLING=1` / `QUANTA_MCP_ROOTS=1` WITHOUT
  // `QUANTA_MCP_CAPS=full` ⇒ the capability is NOT advertised ⇒ no port wired).
  const handler =
    sampling.advertise && sampling.handler !== undefined && compiled.sampling !== undefined
      ? sampling.handler
      : undefined
  const rootsProvider =
    roots.advertise && roots.provider !== undefined && compiled.roots !== undefined
      ? roots.provider
      : undefined
  // Nothing advertised ⇒ omit the bundle entirely (byte-identical load).
  if (handler === undefined && rootsProvider === undefined) return undefined
  return {
    negotiator,
    ...(handler !== undefined ? { handler } : {}),
    ...(rootsProvider !== undefined ? { rootsProvider } : {}),
  }
}

/** RFC04-2/3 (hot-reload) — the observer + source-collector + controller late-
 *  binder the composition root wires when `QUANTA_MCP_HOT_RELOAD` is on. The
 *  observer→controller edge is chicken-and-egg (observer BEFORE `loadMcpTools`,
 *  controller AFTER the registry is built), so the observer calls through a
 *  late-bound `controller` cell set by {@link bindController}. Until bound (i.e.
 *  a `tools/list_changed` that races the controller build) the notification is a
 *  no-op — safe, never a mid-turn swap. */
export interface McpHotReloadWiring {
  /** Passed to `loadMcpTools` as `resourceObserver`: a delivered
   *  `tools_list_changed` (already capability-gated by the client) fires the
   *  bound controller's `requestReload`. Total + no-throw (observer contract). */
  readonly observer: McpResourceObserver
  /** Passed to the bridge as `onReloadSource`: collects one source per
   *  successfully-loaded single-client server. */
  readonly onReloadSource: (source: McpReloadableSource) => void
  /** The collected sources (populated during `loadMcpTools`). */
  readonly sources: McpReloadableSource[]
  /** Late-bind the built controller so the observer can fire it. */
  readonly bindController: (controller: McpToolReloadController) => void
}

/** Build the {@link McpHotReloadWiring} — a fresh observer/collector/binder set,
 *  gated by the caller (`loadFeatures` only calls this when
 *  `mcpHotReloadEnabled()` AND at least one server is configured). Pure, no env
 *  read, no side effects beyond allocating the closures. */
export const buildMcpHotReloadWiring = (): McpHotReloadWiring => {
  const sources: McpReloadableSource[] = []
  let controller: McpToolReloadController | undefined
  const observer: McpResourceObserver = {
    onNotification: (event) => {
      // ONLY a tool-list change relists; resource/prompt changes do not affect
      // the tool registry. The controller coalesces bursts (single-flight+dirty)
      // and retains LKG on a failed relist — this observer just orders the work.
      if (event.kind === "tools_list_changed" && controller !== undefined) {
        // Fire-and-forget: the observer is total + no-throw; the controller's
        // own `requestReload` never rejects (a failed rebuild retains LKG).
        void controller.requestReload()
      }
    },
  }
  return {
    observer,
    onReloadSource: (source) => sources.push(source),
    sources,
    bindController: (c) => {
      controller = c
    },
  }
}

/** RFC04-2/3 (hot-reload) — resolve the {@link McpHotReloadWiring} for a load, or
 *  `undefined` when the feeder is OFF. Gated on: `QUANTA_MCP_HOT_RELOAD` on AND
 *  at least one server configured. Covers BOTH paths: the single-client path
 *  emits `reloadableSingleClientSource`, and the SUPERVISED (auto-restart) path
 *  emits `reloadableSupervisedSource` over the supervisor's stable handle (RFC04
 *  supervised extension) — so a `tools/list_changed` from an auto-restart server
 *  hot-reloads too. `args.autoRestart` no longer gates it out (it is retained so
 *  callers keep passing the session posture, and for the observability of the
 *  decision). Any gate false ⇒ `undefined` ⇒ no observer/collector wired
 *  (byte-identical). */
export const resolveMcpHotReload = (args: {
  readonly configCount: number
  readonly autoRestart: boolean
}): McpHotReloadWiring | undefined =>
  mcpHotReloadEnabled() && args.configCount > 0 ? buildMcpHotReloadWiring() : undefined

/** RFC04-2/3 (hot-reload) — the load-opts hot-reload slice (observer + source
 *  collector) for {@link buildMcpLoadOpts}. Absent wiring ⇒ `{}` (byte-identical). */
export const mcpHotReloadLoadOpts = (
  hotReload: McpHotReloadWiring | undefined,
): Pick<Parameters<typeof buildMcpLoadOpts>[1], "resourceObserver" | "onReloadSource"> =>
  hotReload !== undefined
    ? { resourceObserver: hotReload.observer, onReloadSource: hotReload.onReloadSource }
    : {}

/** RFC04-2/3 (hot-reload) — the {@link Features} hot-reload slice (collected
 *  sources + controller late-binder). Absent wiring ⇒ `{}` (byte-identical). */
export const mcpHotReloadFeatureFields = (
  hotReload: McpHotReloadWiring | undefined,
): Pick<Features, "mcpReloadSources" | "bindMcpReloadController"> =>
  hotReload !== undefined
    ? { mcpReloadSources: hotReload.sources, bindMcpReloadController: hotReload.bindController }
    : {}

/** Assemble the optional `loadMcpTools` opts bag from the resolved feature
 *  gates. Extracted from {@link loadFeatures} so the spread branches do not push
 *  that function over biome's cognitive-complexity cap. Every field is
 *  presence-only: an empty bag is byte-identical to passing `undefined` (every
 *  field is read via `opts?.x` in the bridge). */
export const buildMcpLoadOpts = (
  slog: StructuredLogger,
  args: {
    readonly autoRestart: boolean
    readonly inboundWiring: ReturnType<typeof resolveMcpInboundWiring>
    readonly oauthProvider: McpOAuthProviderPort | undefined
    readonly opts: LoadFeaturesOpts
    /** WS-G (UUX-6-22) — live server-health registry the lifecycle pill reads
     *  per flush. When present, load failures + mid-session deaths mark the
     *  server down AND emit an operator notice. Absent ⇒ neither callback is
     *  wired (byte-identical load). */
    readonly mcpHealth?: McpHealthHolder
    /** RFC04-2/3 (hot-reload) — the capability-gated reload observer, present
     *  ONLY when `QUANTA_MCP_HOT_RELOAD` is on (the composition root gates it).
     *  Threaded into BOTH the supervisor factory AND the single-client opt so
     *  every live server's `tools/list_changed` reaches the SAME `requestReload`.
     *  Absent ⇒ neither path wires an observer (byte-identical load). */
    readonly resourceObserver?: McpResourceObserver
    /** RFC04-2/3 (hot-reload) — the per-(non-supervised)-server reload-source
     *  collector, present ONLY when `QUANTA_MCP_HOT_RELOAD` is on. The bridge
     *  invokes it once per successfully-loaded single-client server with a live
     *  {@link McpReloadableSource}. Absent ⇒ the bridge never calls it
     *  (byte-identical load). */
    readonly onReloadSource?: (source: McpReloadableSource) => void
  },
): Parameters<typeof loadMcpTools>[2] => {
  const isolatedSpawn = isolatedMcpEnabledFromEnv(process.env)
  return {
    // WS-G (UUX-6-22) — route the ALBB-09 load-error sink + the new exit sink
    // into the health registry and the operator-notice bus (error severity: the
    // server's tools WILL fail from here on).
    ...(args.mcpHealth !== undefined
      ? {
          onServerLoadError: ({ server, error }: { server: string; error: unknown }): void => {
            args.mcpHealth?.markDown(server, errMessage(error))
            emitOperatorNotice({
              severity: "error",
              source: "mcp",
              message: `server "${server}" failed to load: ${errMessage(error)}`,
              hint: "its tools are unavailable; see /mcp",
            })
          },
          onServerExit: ({ server, reason }: { server: string; reason?: string }): void => {
            args.mcpHealth?.markDown(server, reason)
            emitOperatorNotice({
              severity: "error",
              source: "mcp",
              message: `server "${server}" exited${reason !== undefined ? ` (${reason})` : ""}`,
              hint: "its tools will fail from now on; see /mcp",
            })
          },
        }
      : {}),
    // B1 + H19 — the SAME unified `{ negotiator, handler?, rootsProvider? }` bundle
    // feeds BOTH paths. On the supervised path it is BAKED into the restart factory
    // (so a reconnected client re-advertises); on the single-client path it is the
    // `samplingWiring` opt the bridge applies to the one client. The transport seam
    // (test-only) is threaded into the supervisor factory too so a supervised
    // client can be driven by a scripted transport. H18 (jun-06) — the OAuth
    // provider rides BOTH paths identically: baked into the supervisor factory AND
    // passed as the single-client `oauthProvider` opt.
    ...(args.autoRestart
      ? {
          supervisorDepsFor: mcpSupervisorDepsFor(
            slog,
            args.inboundWiring,
            args.opts.mcpTransportFor,
            args.oauthProvider,
            args.opts.proxyEnv,
            args.resourceObserver,
            isolatedSpawn,
          ),
        }
      : {}),
    ...(args.inboundWiring !== undefined ? { samplingWiring: args.inboundWiring } : {}),
    // RFC04-2/3 (hot-reload) — the single-client path reads `resourceObserver`
    // off the opts bag (the supervised path baked it into the factory above). ONE
    // shared instance so ANY server's list-change orders the SAME relist. Present
    // only when `QUANTA_MCP_HOT_RELOAD` is on; absent ⇒ slot omitted (byte-identical).
    ...(args.resourceObserver !== undefined ? { resourceObserver: args.resourceObserver } : {}),
    // RFC04-2/3 (hot-reload) — BOTH paths emit one reload source per successfully-
    // loaded server through this sink (single-client over the live client; the
    // supervised path over the supervisor's stable handle — `loadMcpTools` forwards
    // it to `loadSupervised`). Present only when the gate is on; absent ⇒
    // byte-identical.
    ...(args.onReloadSource !== undefined ? { onReloadSource: args.onReloadSource } : {}),
    ...(args.opts.mcpTransportFor !== undefined ? { transportFor: args.opts.mcpTransportFor } : {}),
    ...(args.oauthProvider !== undefined ? { oauthProvider: args.oauthProvider } : {}),
    // H3 (jun-10 session-scoped egress) — the session proxy env (opened once at
    // bootstrap, BEFORE any MCP spawn) rides BOTH the single-client and the
    // supervised path so every stdio server child's own sockets are forced through
    // the loopback allowlist. Absent / proxy OFF ⇒ slot omitted ⇒ byte-identical.
    ...(args.opts.proxyEnv !== undefined ? { proxyEnv: args.opts.proxyEnv } : {}),
    ...(isolatedSpawn ? { isolatedSpawn: true } : {}),
    // §19.1 (QUANTA_MCP_TOOL_ANNOTATIONS) — the global default-OFF master switch.
    // OFF (default) ⇒ slot omitted ⇒ the bridge's `annotationsHonored` stays false
    // ⇒ `honored = annotationsHonored && trusted` is false for EVERY tool, so the
    // read/concurrency predicates keep their conservative classification
    // (byte-identical). ON ⇒ a TRUSTED server's annotations may elevate them.
    ...(runtimeConfig().mcpToolAnnotations ? { annotationsHonored: true } : {}),
  }
}

/** Start the configured MCP servers (or short-circuit to an empty bundle when
 *  none are configured), returning the same `{ tools, clients, resources? }`
 *  shape `loadMcpTools` produces. Extracted so {@link loadFeatures} carries no
 *  inline ternary branch over the load (keeps it under biome's cognitive-
 *  complexity cap). Zero configs ⇒ no client started (byte-identical). */
export const loadMcpToolsOrEmpty = async (
  mcpConfigs: McpServerConfig[],
  elicitationPrompterFor: ElicitationPrompterFactory | undefined,
  mcpLoadOpts: Parameters<typeof loadMcpTools>[2],
): Promise<{ tools: Tool[]; clients: McpStoppable[]; resources?: ResourcesHandle }> => {
  if (mcpConfigs.length === 0) return { tools: [], clients: [] }
  return loadMcpTools(mcpConfigs, elicitationPrompterFor, mcpLoadOpts)
}

/** N3 (QUANTA_MCP_RESOURCES) — build the four `mcp_*` resource/prompt tools when
 *  the knob is ON AND the bridge produced an aggregate `ResourcesHandle` (i.e. at
 *  least one connected server advertised `resources`/`prompts`). They register
 *  through the mcp-origin `mcpTools` array (NOT `DefaultToolPorts`) so the
 *  registry tags them `mcp` ⇒ `deriveProvenance(name,"mcp")` ⇒ the H2/ADR-0471
 *  `<untrusted-source>` envelope wraps their output at dispatch (the documented
 *  security invariant for these tools). Knob off OR no capable server ⇒ `[]` ⇒
 *  the tools are absent + the registry is byte-identical. Extracted so
 *  {@link loadFeatures} stays under biome's cognitive-complexity cap. */
export const buildMcpResourceTools = (
  resources: ResourcesHandle | undefined,
  /** B4 (jul-04 CLI-surfacing) — OPTIONAL surface-owned capture holder threaded
   *  into the two fetch tools so `/mcp-resources` lists what the model fetched.
   *  The SAME instance is returned on {@link Features.mcpResourceCapture} so the
   *  surface reads the exact ring the tools write into (one holder, both
   *  consumers). Absent ⇒ the tools are byte-identical (no capture). */
  capture?: McpResourceCaptureHolder,
): Tool[] =>
  runtimeConfig().mcpResources && resources !== undefined
    ? mcpResourcesTools(resources, capture)
    : []
