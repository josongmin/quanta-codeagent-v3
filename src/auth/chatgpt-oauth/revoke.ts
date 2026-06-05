/** RFC 7009 OAuth 2.0 Token Revocation — best-effort, NO-THROW.
 *
 *  `revokeRefreshToken` POSTs a refresh token to the IdP's revocation endpoint
 *  so the server-side credential is invalidated, not merely forgotten on disk.
 *  It is the network counterpart to `deleteToken` (token-store.ts): the caller
 *  runs this FIRST, then deletes locally UNCONDITIONALLY — a revoke that fails
 *  (no endpoint, network error, non-2xx, missing token) NEVER throws and NEVER
 *  blocks the local delete, so logout can only ever match-or-beat today's
 *  local-only behavior (RFC §4.5, §8).
 *
 *  Closed-port: the only side effect is the injected `fetchPort`; the clock is
 *  injected too. No global `fetch`, no `process.env`, no `Date.now` here.
 */

import type { FetchLike } from "./refresh"

/** Re-exported under a revoke-specific name so callers read intent at the seam.
 *  Structurally identical to the OAuth flow's fetch seam (refresh.ts) so the
 *  global `fetch` and any test stub are assignable. */
export type FetchPort = FetchLike

export interface RevokeLogger {
  warn(msg: string, ctx?: unknown): void
}

export interface RevokeDeps {
  /** Injected — same seam as the refresh/token POST. */
  readonly fetchPort: FetchPort
  /** Optional structured logger. Receives ONLY a reason + `error.message` —
   *  NEVER the token (RFC §4.5, hellgate 7). */
  readonly logger?: RevokeLogger | undefined
}

export interface RevokeInput {
  /** The IdP revocation endpoint (default `${issuer}/oauth/revoke`, RFC §4.2). */
  readonly revocationEndpoint: string
  readonly clientId: string
  /** The long-lived secret to invalidate server-side. Rides the POST BODY only
   *  (RFC 7009 §2.1) — never a URL/argv/log. */
  readonly refreshToken: string
}

/** Why a revoke did not (provably) succeed. The caller reads this ONLY to
 *  render a UX note — it NEVER gates the unconditional local delete. */
export type RevokeFailureReason = "no-token" | "network" | "non-2xx"

export type RevokeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RevokeFailureReason }

/** Local copy of the shared `errMessage` contract so this leaf does not import
 *  the `@/shared` barrel for one helper. Stringifies any thrown value WITHOUT
 *  leaking surrounding context (the token is never part of an Error here). */
const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error"

/** RFC 7009 best-effort revoke of a refresh token. NEVER throws: every failure
 *  resolves to a typed {@link RevokeOutcome} so the caller can log + proceed to
 *  the LOCAL delete unconditionally.
 *
 *  RFC 7009 §2.2: a successful revoke returns 200; an unknown/already-revoked
 *  token ALSO returns 200 (idempotent) — so a double-logout is harmless. Any
 *  2xx is treated as success; any non-2xx is `non-2xx` (logged + swallowed). */
export const revokeRefreshToken = async (
  deps: RevokeDeps,
  input: RevokeInput,
): Promise<RevokeOutcome> => {
  if (input.refreshToken.length === 0) return { ok: false, reason: "no-token" }
  try {
    const res = await deps.fetchPort(input.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: input.refreshToken,
        token_type_hint: "refresh_token",
        client_id: input.clientId,
      }).toString(),
    })
    if (res.ok) return { ok: true }
    // Non-2xx (incl. a 404 from an IdP without a revoke endpoint, §8): logged
    // with the STATUS only — never the token — then swallowed.
    deps.logger?.warn("oauth-revoke: non-2xx response (token deleted locally anyway)", {
      status: res.status,
    })
    return { ok: false, reason: "non-2xx" }
  } catch (e) {
    deps.logger?.warn("oauth-revoke: network failure (token deleted locally anyway)", {
      error: errMessage(e), // never the token
    })
    return { ok: false, reason: "network" }
  }
}

/** RFC §4.2: the default revocation endpoint for a given issuer. Mirrors
 *  `browser-flow.ts`'s `${issuer}/oauth/*` construction. For chatgpt-oauth (a
 *  single fixed issuer) the default is sufficient; RFC 8414 discovery is the
 *  MCP-side path (Phase 2) which already owns the machinery. */
export const defaultRevocationEndpoint = (issuer: string): string => `${issuer}/oauth/revoke`
