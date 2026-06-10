/** H18 (jun-04) — the `@/connectors`-backed implementation of the MCP HTTP
 *  OAuth port, wired at the composition root.
 *
 *  ## Why this lives in the host layer (not `@/mcp`)
 *
 *  Authenticating an HTTP MCP server requires RFC 8414 discovery, RFC 7591
 *  dynamic client registration, a loopback + PKCE browser flow, a token store,
 *  and RFC 6749 §6 refresh — all in `@/connectors` and `@/auth`. But `@/mcp`
 *  MUST NOT import those slices (slice isolation, RFC §3.1: `@/mcp` depends on
 *  `@/shared` only) — exactly why {@link McpOAuthProviderPort} exists as a DI
 *  seam. The concrete, connectors-backed implementation is assembled HERE, the
 *  only layer allowed to reach both `@/mcp` and `@/connectors`, and injected
 *  into the `McpClient`.
 *
 *  ## What it reuses (connect, don't rebuild)
 *
 *    - `discoverOAuthEndpoints` (RFC 8414 well-known + OIDC fallback) for the
 *      authorize/token endpoints;
 *    - `registerOAuthClient` (RFC 7591 DCR) when the IdP advertises a
 *      registration endpoint and we have no static client id;
 *    - the supplied `runBrowserFlow` (loopback HTTP + PKCE) for the user-facing
 *      authorize step — the SAME seam the chatgpt-oauth `/login` flow uses;
 *    - `createTokenRotator` (RFC 6749 §6 refresh, in-flight mutex, atomic
 *      persist) over the injected `TokenStorePort` for refresh-on-expiry.
 *
 *  ## Total contract (no throws into the MCP load)
 *
 *  {@link McpOAuthProviderPort.tokenFor} is TOTAL: every failure — discovery
 *  error, browser-flow decline, token-exchange rejection, store error — is
 *  caught and mapped to `undefined` (proceed unauthenticated; the server answers
 *  401 surfaced like any other error) rather than crashing the load.
 *
 *  ## Tokens never logged
 *
 *  Access/refresh tokens flow only between the IdP, the store, and the returned
 *  bearer string. They are never passed to a logger and the provider object
 *  holds no token in an enumerable field.
 */

import {
  type ClockPort,
  createTokenRotator,
  discoverOAuthEndpoints,
  type FetchPort,
  type OAuthEndpoints,
  registerOAuthClient,
  type TokenRecord,
  TokenRotationError,
  type TokenStorePort,
} from "@/connectors"
import type { McpOAuthProviderPort } from "@/mcp"
import { errMessage, logger, runtimeConfig } from "@/shared"
import { composeTokenStore } from "./keyring/compose"
import type { KeyringExec, KeyringPlatform } from "./keyring/port"
import { bunKeyringExec, selectKeyring } from "./keyring/select"

/** Result of the injected browser flow — the redeemable authorization code plus
 *  the PKCE verifier + redirect_uri needed to exchange it. Structurally mirrors
 *  `@/auth/chatgpt-oauth` `BrowserFlowResult` (the composition root passes a
 *  thin adapter over `runBrowserFlow`). */
export interface McpBrowserFlowResult {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

/** Run the surface's browser flow for one server's `authorizeEndpoint`. The
 *  composition root supplies this over `@/auth/chatgpt-oauth` `runBrowserFlow`
 *  (loopback HTTP + PKCE), adapted to the discovered authorize endpoint. */
export type RunMcpBrowserFlow = (input: {
  readonly authorizeEndpoint: string
  readonly clientId: string
  readonly serverName: string
}) => Promise<McpBrowserFlowResult>

export interface ConnectorsMcpOAuthConfig {
  /** Network seam (RFC 8414 discovery, DCR, token exchange). */
  readonly fetchPort: FetchPort
  /** Where MCP OAuth tokens are persisted (file store with 0600, or a keyring
   *  adapter later). Keyed by server name. */
  readonly tokenStore: TokenStorePort
  /** Monotonic clock for expiry checks. */
  readonly clockPort: ClockPort
  /** Surface browser flow (loopback HTTP + PKCE). */
  readonly runBrowserFlow: RunMcpBrowserFlow
  /** Static OAuth client id. When set, DCR is skipped. Optional — when omitted
   *  AND the IdP advertises a registration endpoint, the provider performs RFC
   *  7591 dynamic client registration to obtain one. */
  readonly clientId?: string
  /** Resolve the OAuth issuer URL for a server name (from the MCP server config
   *  / connector registry). Returning `undefined` means "no issuer known" ⇒ the
   *  provider obtains no token (unauthenticated). */
  readonly issuerFor: (serverName: string) => string | undefined
  /** Default redirect URI used for DCR client metadata. The browser flow's own
   *  redirect_uri (loopback) is what is actually used at authorize time; this is
   *  the value registered with the IdP. Defaults to a loopback localhost URI. */
  readonly registrationRedirectUri?: string
}

const DEFAULT_REGISTRATION_REDIRECT = "http://localhost:1455/auth/callback"

/** Build the `application/x-www-form-urlencoded` body for a token-endpoint POST
 *  (RFC 6749). Kept here (not in `@/connectors`) because the host owns the wire
 *  shape — exactly as `token-rotation.ts` documents ("the callback owns the
 *  network shape — RFC 6749 §6 refresh_token, PKCE"). */
const formBody = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")

/** Jun-10 silent-failure audit #16 — TYPED token-endpoint failure carrying the
 *  numeric status (+ the RFC 6749 §5.2 `error` code when the body has one), so
 *  the refresh catch can branch on `status`/`errorCode` instead of an opaque
 *  status-string Error. Without it a transient 503 was indistinguishable from
 *  a revoked refresh token → surprise interactive re-auth + the still-valid
 *  refresh token overwritten. Carries NO token material (safe to log). */
export class McpTokenEndpointError extends Error {
  readonly status: number
  readonly errorCode?: string
  constructor(status: number, errorCode?: string) {
    super(`token endpoint returned status ${status}${errorCode ? ` (${errorCode})` : ""}`)
    this.name = "McpTokenEndpointError"
    this.status = status
    if (errorCode !== undefined) this.errorCode = errorCode
  }
}

/** Audit #16 — is this refresh failure an ACTUAL revocation? Per the audit
 *  checklist, `invalid_grant`/401 is the ONLY re-auth trigger; every other
 *  failure (429/5xx/network/malformed body/store write) is transient and MUST
 *  NOT pop an interactive flow or overwrite the stored refresh token. The
 *  rotator wraps the grant's error in a `TokenRotationError`, so unwrap its
 *  `cause` first. */
const isRefreshRevocation = (e: unknown): boolean => {
  const inner = e instanceof TokenRotationError ? e.cause : e
  return (
    inner instanceof McpTokenEndpointError &&
    (inner.status === 401 || inner.errorCode === "invalid_grant")
  )
}

/** Best-effort RFC 6749 §5.2 error-code extraction from a non-2xx token-endpoint
 *  body (`invalid_grant` is the explicit revocation signal, usually on a 400).
 *  Malformed/non-JSON body ⇒ `undefined` (the numeric status alone still types
 *  the branch). */
const extractOAuthErrorCode = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed !== null && typeof parsed === "object") {
      const code = (parsed as Record<string, unknown>).error
      if (typeof code === "string") return code
    }
  } catch {
    // non-JSON error body — fall through
  }
  return undefined
}

/** Parse a token-endpoint JSON response into a connectors `TokenRecord`. Throws
 *  a typed {@link McpTokenEndpointError} on a non-2xx (so the refresh catch can
 *  branch on the status) and a plain Error on a malformed 2xx body; the initial
 *  path's outer catch maps either to `undefined`. */
const parseTokenResponse = (
  status: number,
  ok: boolean,
  body: string,
  clock: ClockPort,
): TokenRecord => {
  if (!ok) throw new McpTokenEndpointError(status, extractOAuthErrorCode(body))
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new Error(`token endpoint returned non-JSON: ${errMessage(e)}`)
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("token endpoint returned a non-object body")
  }
  const o = parsed as Record<string, unknown>
  const accessToken = o.access_token
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("token endpoint response missing access_token")
  }
  const expiresIn = typeof o.expires_in === "number" ? o.expires_in : undefined
  return {
    accessToken,
    tokenType: typeof o.token_type === "string" ? o.token_type : "Bearer",
    ...(typeof o.refresh_token === "string" ? { refreshToken: o.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresAt: clock.now() + expiresIn * 1000 } : {}),
  }
}

/** The connectors-backed {@link McpOAuthProviderPort}. Per-server state (the
 *  resolved endpoints + client id) is memoized so discovery/DCR run once. */
export const createConnectorsMcpOAuthProvider = (
  cfg: ConnectorsMcpOAuthConfig,
): McpOAuthProviderPort => {
  const rotator = createTokenRotator({ tokenStore: cfg.tokenStore, clockPort: cfg.clockPort })
  // Per-server resolved endpoints + effective client id (discovery/DCR once).
  const endpointsCache = new Map<string, { endpoints: OAuthEndpoints; clientId: string }>()

  /** RFC 8414 discovery (+ optional RFC 7591 DCR) for one server, memoized. */
  const resolveEndpoints = async (
    serverName: string,
    issuer: string,
  ): Promise<{ endpoints: OAuthEndpoints; clientId: string }> => {
    const cached = endpointsCache.get(serverName)
    if (cached !== undefined) return cached
    const endpoints = await discoverOAuthEndpoints(issuer, cfg.fetchPort)
    let clientId = cfg.clientId
    if (clientId === undefined && endpoints.registrationEndpoint !== undefined) {
      // No static client id but the IdP supports DCR → register one (RFC 7591).
      const reg = await registerOAuthClient(
        endpoints.registrationEndpoint,
        {
          redirectUris: [cfg.registrationRedirectUri ?? DEFAULT_REGISTRATION_REDIRECT],
          clientName: `quanta-mcp:${serverName}`,
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
        },
        cfg.fetchPort,
      )
      clientId = reg.clientId
    }
    if (clientId === undefined) {
      throw new Error(
        `no OAuth client id for "${serverName}" (set one or use an IdP advertising registration)`,
      )
    }
    const resolved = { endpoints, clientId }
    endpointsCache.set(serverName, resolved)
    return resolved
  }

  /** Exchange an authorization code for a token (RFC 6749 §4.1.3, PKCE). */
  const exchangeAuthCode = async (
    tokenEndpoint: string,
    clientId: string,
    flow: McpBrowserFlowResult,
  ): Promise<TokenRecord> => {
    const res = await cfg.fetchPort(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        code: flow.code,
        redirect_uri: flow.redirectUri,
        client_id: clientId,
        code_verifier: flow.verifier,
      }),
    })
    return parseTokenResponse(res.status, res.ok, await res.text(), cfg.clockPort)
  }

  /** Refresh an access token (RFC 6749 §6). Throws on rejection so the caller
   *  falls back to a fresh authorization. */
  const refreshGrant = async (
    tokenEndpoint: string,
    clientId: string,
    refreshToken: string,
  ): Promise<TokenRecord> => {
    const res = await cfg.fetchPort(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    })
    const next = parseTokenResponse(res.status, res.ok, await res.text(), cfg.clockPort)
    // Some IdPs omit a rotated refresh_token on refresh — carry the prior one
    // forward so the next refresh still has a credential (RFC 6749 §6 allows
    // either behavior).
    return next.refreshToken !== undefined ? next : { ...next, refreshToken }
  }

  /** Run the full discovery → (DCR) → browser flow → code-exchange → store path
   *  for a fresh authorization. */
  const authorizeFresh = async (serverName: string, issuer: string): Promise<TokenRecord> => {
    const { endpoints, clientId } = await resolveEndpoints(serverName, issuer)
    const flow = await cfg.runBrowserFlow({
      authorizeEndpoint: endpoints.authorizeEndpoint,
      clientId,
      serverName,
    })
    const record = await exchangeAuthCode(endpoints.tokenEndpoint, clientId, flow)
    await cfg.tokenStore.write(serverName, record)
    return record
  }

  // Coalesce concurrent `tokenFor` calls for the SAME server: the rotator only
  // coalesces the refresh GRANT, but the FRESH-authorization path (RFC 6749
  // §4.1, interactive browser flow) is NOT a rotator op — without this guard two
  // concurrent first-token requests would each pop a browser window and each
  // POST the auth-code, double-spending the single-use code. One in-flight
  // resolution per server fixes that; the entry is cleared in `finally` so the
  // NEXT (post-expiry) acquisition starts fresh.
  const inFlightToken = new Map<string, Promise<string | undefined>>()

  const resolveTokenFor = async (
    serverName: string,
    issuer: string,
  ): Promise<string | undefined> => {
    try {
      const existing = await rotator.read(serverName)
      // 1. A stored, unexpired token → reuse (no flow, no refresh).
      if (existing !== undefined && !rotator.isExpired(existing)) return existing.accessToken
      // 2. An expired token WITH a refresh_token → try RFC 6749 §6 refresh,
      //    coalesced through the rotator (in-flight mutex + atomic persist).
      if (existing?.refreshToken !== undefined) {
        const { endpoints, clientId } = await resolveEndpoints(serverName, issuer)
        try {
          const refreshed = await rotator.rotate(serverName, async () =>
            refreshGrant(endpoints.tokenEndpoint, clientId, existing.refreshToken as string),
          )
          return refreshed.accessToken
        } catch (e) {
          // Audit #16 — branch on the TYPED status: only invalid_grant/401
          // means the refresh token is dead.
          if (!isRefreshRevocation(e)) {
            // 3a. TRANSIENT failure (429/5xx/network/store) → degrade to
            //     unauthenticated for THIS load. NO interactive re-auth (no
            //     surprise browser pop) and the stored, still-valid refresh
            //     token is left untouched for the next acquisition.
            logger.warn("mcp-oauth: transient refresh failure — keeping stored refresh token", {
              server: serverName,
              error: errMessage(e),
            })
            return undefined
          }
          // 3b. Refresh REJECTED (revoked/expired refresh_token) → re-authorize.
          logger.info("mcp-oauth: refresh rejected (revoked), re-authorizing", {
            server: serverName,
          })
        }
      }
      // 4. No usable token (or refresh failed) → fresh authorization flow.
      const fresh = await authorizeFresh(serverName, issuer)
      return fresh.accessToken
    } catch (e) {
      // Total contract: a failed login degrades to unauthenticated, never throws
      // into the MCP load. The error MESSAGE is logged (never the token).
      logger.warn("mcp-oauth: could not obtain token", {
        server: serverName,
        error: errMessage(e),
      })
      return undefined
    }
  }

  const tokenFor = async (serverName: string): Promise<string | undefined> => {
    const issuer = cfg.issuerFor(serverName)
    if (issuer === undefined) return undefined
    // Share one in-flight acquisition per server so concurrent callers cannot
    // each launch the interactive browser flow / replay a single-use auth code.
    const existing = inFlightToken.get(serverName)
    if (existing !== undefined) return existing
    const p = resolveTokenFor(serverName, issuer).finally(() => {
      inFlightToken.delete(serverName)
    })
    inFlightToken.set(serverName, p)
    return p
  }

  const invalidate = async (serverName: string): Promise<void> => {
    await rotator.forget(serverName)
  }

  // Return a frozen object with non-enumerable internals — `JSON.stringify` /
  // `String()` of the provider expose no token-bearing closure state.
  return Object.freeze({ tokenFor, invalidate })
}

// ────────────────────────────────────────────────────────────────────────────
// Advertise-iff-able wiring (mirrors `buildSamplingWiring`).
// ────────────────────────────────────────────────────────────────────────────

/** The deps the host injects to build the connectors-backed provider. Sourced
 *  at the composition root: `fetchPort` from the platform fetch, `tokenStore`
 *  from the file-backed store (0600), `clockPort` from the system clock,
 *  `runBrowserFlow` over `@/auth/chatgpt-oauth`, `issuerFor` from the MCP server
 *  configs. */
export type McpOAuthDeps = ConnectorsMcpOAuthConfig

/** The single artifact a deployment needs to enable MCP OAuth: the provider to
 *  inject into each `McpClient` (present IFF the knob is ON AND deps are
 *  available). When absent the client falls back to {@link
 *  import("@/mcp").headlessOAuthRejecter} — the advertise-iff-able default. */
export interface McpOAuthWiring {
  readonly provider: McpOAuthProviderPort | undefined
}

/** Optional OS-keyring decorator for the OAuth `TokenStorePort` (jun-06,
 *  QUANTA_MCP_OAUTH_KEYRING). When `enabled`, the file-backed `deps.tokenStore`
 *  is wrapped with `composeTokenStore(selectKeyring(platform, exec), fileStore)`
 *  so tokens live in Keychain / libsecret (file-fallback + migration, NO-THROW).
 *  OFF / unsupported platform ⇒ the file store is used unchanged (byte-identical).
 *  The platform + exec are INJECTED (the function stays pure — no
 *  `process.platform` read inside). */
export interface McpOAuthKeyringOption {
  readonly enabled: boolean
  readonly platform: KeyringPlatform
  readonly exec: KeyringExec
}

/** The single decision point for the opt-in invariant. Returns a provider ONLY
 *  when the knob is ON AND deps are present; otherwise `{ provider: undefined }`
 *  (byte-identical to the unwired default — no discovery, no flow, no header).
 *
 *  Because the provider is returned from the SAME gate, a caller cannot wire a
 *  provider while the knob is off, or leave the knob on with no provider.
 *
 *  When `keyring?.enabled` is true, the provider's token store is the
 *  keyring-composed store (Keychain/libsecret over the file store); OFF/absent ⇒
 *  the plain file store (byte-identical to pre-keyring H18). */
export const buildMcpOAuthWiring = (
  enabled: boolean,
  deps: McpOAuthDeps | undefined,
  keyring?: McpOAuthKeyringOption,
): McpOAuthWiring => {
  if (!enabled || deps === undefined) return { provider: undefined }
  const tokenStore =
    keyring?.enabled === true
      ? composeTokenStore(selectKeyring(keyring.platform, keyring.exec), deps.tokenStore)
      : deps.tokenStore
  return { provider: createConnectorsMcpOAuthProvider({ ...deps, tokenStore }) }
}

/** Composition-root resolver for the keyring option (jun-06). This is the ONLY
 *  place that reads `process.platform` for the keyring decision (the keyring
 *  slice + `buildMcpOAuthWiring` stay pure — `platform`/`exec` are INJECTED).
 *  Returns the option shaped for `buildMcpOAuthWiring`'s 3rd argument:
 *    - `enabled` from `runtimeConfig().mcpOAuthKeyring` (QUANTA_MCP_OAUTH_KEYRING),
 *    - `platform` from the live `process.platform`,
 *    - `exec` from the real `Bun.spawn`-backed {@link bunKeyringExec}.
 *  When the knob is OFF (default) `enabled` is false ⇒ `buildMcpOAuthWiring`
 *  uses the plain file store (byte-identical to the pre-keyring H18 default).
 *  A host that wires the MCP OAuth provider passes the result straight through:
 *  `buildMcpOAuthWiring(enabled, deps, resolveMcpOAuthKeyringOption())`. */
export const resolveMcpOAuthKeyringOption = (
  platform: KeyringPlatform = process.platform,
): McpOAuthKeyringOption => ({
  enabled: runtimeConfig().mcpOAuthKeyring,
  platform,
  exec: bunKeyringExec(),
})
