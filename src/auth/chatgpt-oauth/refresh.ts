import { URLSearchParams } from "node:url"
import type { OAuthConfig } from "./config"
import { decodeJwtClaims } from "./jwt"
import type { TokenRecord } from "./token-store"

/** Minimal fetch shape so callers can pass a unit-test stub without
 *  having to satisfy the full `typeof fetch` interface (`preconnect`,
 *  overload soup, etc.). The global `fetch` is structurally assignable
 *  to this type. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class TokenExchangeError extends Error {
  readonly statusCode: number
  readonly errorCode?: string
  readonly description?: string
  constructor(statusCode: number, body: { error?: string; error_description?: string } | null) {
    const code = body?.error ?? "unknown"
    const desc = body?.error_description ?? "no description"
    super(`token exchange failed: ${statusCode} ${code}: ${desc}`)
    this.name = "TokenExchangeError"
    this.statusCode = statusCode
    if (body?.error) this.errorCode = body.error
    if (body?.error_description) this.description = body.error_description
  }
}

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token?: string
  readonly id_token?: string
  readonly expires_in?: number
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object"

const parseTokenResponse = (raw: unknown): TokenResponse => {
  if (!isObject(raw)) {
    throw new TokenExchangeError(0, {
      error: "shape",
      error_description: "response is not a JSON object",
    })
  }
  // L6 H4: type-only checks let an EMPTY access_token through — which the
  // issuer never returns on success, and which produces a spurious 401 at the
  // first wire call instead of a clear "re-login" signal here. Reject it at the
  // boundary, aligned with `github-token-rotation.ts` / `oidc-federation.ts`.
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new TokenExchangeError(0, {
      error: "shape",
      error_description: "access_token missing, not a string, or empty",
    })
  }
  // L6 H4: a non-finite / non-positive `expires_in` would mint a token that is
  // already expired (or NaN-expiry), looping the user through refresh forever.
  // Drop a present-but-invalid value rather than silently trusting it.
  if (raw.expires_in !== undefined) {
    if (
      typeof raw.expires_in !== "number" ||
      !Number.isFinite(raw.expires_in) ||
      raw.expires_in <= 0
    ) {
      throw new TokenExchangeError(0, {
        error: "shape",
        error_description: "expires_in is not a finite positive number",
      })
    }
  }
  return {
    access_token: raw.access_token,
    ...(typeof raw.refresh_token === "string" ? { refresh_token: raw.refresh_token } : {}),
    ...(typeof raw.id_token === "string" ? { id_token: raw.id_token } : {}),
    ...(typeof raw.expires_in === "number" ? { expires_in: raw.expires_in } : {}),
  }
}

const DEFAULT_EXPIRES_IN_SEC = 60 * 60

const buildRecord = (
  tr: TokenResponse,
  prevRefresh: string | undefined,
  nowMs: number,
): TokenRecord => {
  const refresh = tr.refresh_token ?? prevRefresh
  if (!refresh) {
    throw new TokenExchangeError(0, {
      error: "shape",
      error_description: "no refresh_token in response and none cached",
    })
  }
  const expSec = tr.expires_in ?? DEFAULT_EXPIRES_IN_SEC
  const expiresAt = new Date(nowMs + expSec * 1000).toISOString()

  let planType: string | undefined
  let accountId: string | undefined
  if (tr.id_token !== undefined) {
    try {
      const claims = decodeJwtClaims(tr.id_token)
      planType = claims.chatgpt_plan_type
      accountId = claims.chatgpt_account_id
    } catch {
      // Non-fatal: surface plan_type=unknown in /status. The wire call will
      // still proceed and the backend is authoritative.
    }
  }

  return {
    access_token: tr.access_token,
    refresh_token: refresh,
    expires_at: expiresAt,
    ...(tr.id_token !== undefined ? { id_token: tr.id_token } : {}),
    ...(accountId !== undefined ? { account_id: accountId } : {}),
    ...(planType !== undefined ? { plan_type: planType } : {}),
    last_refresh: new Date(nowMs).toISOString(),
  }
}

const parseExchange = async (
  res: Response,
  prevRefresh: string | undefined,
  nowMs: number,
): Promise<TokenRecord> => {
  const text = await res.text()
  let parsed: unknown = null
  if (text !== "") {
    try {
      parsed = JSON.parse(text)
    } catch {
      // body parse failure handled by !res.ok branch below
    }
  }
  if (!res.ok) {
    const bodyObj = isObject(parsed)
      ? {
          ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
          ...(typeof parsed.error_description === "string"
            ? { error_description: parsed.error_description }
            : {}),
        }
      : null
    throw new TokenExchangeError(res.status, bodyObj)
  }
  const tr = parseTokenResponse(parsed)
  return buildRecord(tr, prevRefresh, nowMs)
}

export interface ExchangeCodeInput {
  readonly cfg: OAuthConfig
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
  readonly fetchImpl?: FetchLike
  readonly nowMs?: () => number
}

/** Exchange an authorization code for a fresh token bundle. */
export const exchangeCode = async (input: ExchangeCodeInput): Promise<TokenRecord> => {
  const fetchImpl = input.fetchImpl ?? fetch
  const now = input.nowMs?.() ?? Date.now()
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.cfg.clientId,
    code_verifier: input.verifier,
  })
  const res = await fetchImpl(`${input.cfg.issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  })
  return parseExchange(res, undefined, now)
}

export interface RefreshInput {
  readonly cfg: OAuthConfig
  readonly current: TokenRecord
  readonly fetchImpl?: FetchLike
  readonly nowMs?: () => number
}

const refreshKey = (cfg: OAuthConfig, refreshToken: string): string =>
  `${cfg.issuer}\x00${cfg.clientId}\x00${refreshToken}`

const doRefresh = async (input: RefreshInput): Promise<TokenRecord> => {
  const fetchImpl = input.fetchImpl ?? fetch
  const now = input.nowMs?.() ?? Date.now()
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.cfg.clientId,
    refresh_token: input.current.refresh_token,
    scope: "openid profile email offline_access",
  })
  const res = await fetchImpl(`${input.cfg.issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  })
  return parseExchange(res, input.current.refresh_token, now)
}

/** Coordinates concurrent refresh_token exchanges: callers sharing the same
 *  (issuer, clientId, refresh_token) tuple await one in-flight promise rather
 *  than racing two requests at the issuer. Codex doesn't guard this — we do.
 *
 *  Use the module-level {@link refreshToken} for the process-wide default
 *  coordinator. Instantiate `new RefreshCoordinator()` when a caller (e.g. a
 *  per-adapter test harness, or Phase 2's Streaming adapter wanting isolated
 *  dedup) needs its own in-flight table. */
export class RefreshCoordinator {
  private readonly inflight = new Map<string, Promise<TokenRecord>>()

  /** Refresh the access token. Concurrent calls with the same key share one
   *  in-flight request — no thundering-herd at the issuer (audit L6 M12). The
   *  slot is retained for the FULL lifetime of the request (set BEFORE any
   *  caller can observe a settle) and cleared only once the promise settles, so
   *  every caller that arrives while the request is in flight — resolve OR
   *  reject — deduplicates onto the SAME promise and observes the SAME outcome
   *  (a rejection is shared, never swallowed for the second caller). Cleared on
   *  settle so a long-lived coordinator does not accumulate dead slots.
   *
   *  Caller contract: every caller MUST attach its own `.catch`/`await … catch`
   *  — the shared rejected promise is handed to N callers, and an un-awaited
   *  copy would surface as an unhandled rejection. */
  async refresh(input: RefreshInput): Promise<TokenRecord> {
    const key = refreshKey(input.cfg, input.current.refresh_token)
    const existing = this.inflight.get(key)
    if (existing) return existing
    // Set the slot synchronously, BEFORE awaiting, so a second caller in the
    // same microtask turn sees the in-flight entry and dedups. Clear on settle.
    const p = doRefresh(input).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }

  /** Test-only: drop all in-flight slots. Production code MUST NOT call this. */
  __reset(): void {
    this.inflight.clear()
  }

  /** Test-only: number of in-flight slots currently retained. Useful for
   *  asserting memory hygiene (size === 0 after every refresh settles). */
  __sizeForTest(): number {
    return this.inflight.size
  }
}

/** Process-wide default coordinator. Preserves the historical singleton
 *  behavior of `refreshToken` so existing callers keep deduping against the
 *  same in-flight table. */
const defaultCoordinator = new RefreshCoordinator()

/** Refresh the access token via the process-wide default coordinator.
 *  Byte-identical to the pre-refactor module-level function. */
export const refreshToken = (input: RefreshInput): Promise<TokenRecord> =>
  defaultCoordinator.refresh(input)

/** Test seam: clear the default coordinator's in-flight map between tests. */
export const __resetInflightForTest = (): void => {
  defaultCoordinator.__reset()
}
