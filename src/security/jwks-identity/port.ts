/**
 * JWKS agent identity port (ADR-0248).
 *
 * Hexagonal seam for "fetch a remote JWKS endpoint and verify JWTs against
 * its cached keys". Verify-only — signing is an explicit deliberate_hold.
 *
 * The default adapter (`default-client.ts`) implements this port with
 * built-in `fetch` + a TTL cache + Web Crypto signature verification.
 * Surfaces that explicitly skip JWKS verification (e.g. headless local-only
 * mode) get a typed no-op via `headless-stub.ts`.
 *
 * Default-OFF: nothing in `src/agent/**`, `src/runner/**`, `src/tool/**`,
 * `src/scheduler/**`, or `src/realtime/**` imports this slice today. The
 * future caller (agent-task registrar, realtime auth, scheduler webhook)
 * opts in by composing a `JwksClient` at the composition root.
 */

import type { JwksSet, VerifyResult } from "./types"

/**
 * The four-method hexagonal port. Implementations may add private state
 * (e.g. an in-memory cache map) but the public surface is exactly these four
 * methods.
 *
 * - `fetchJwks(url)` — network fetch + parse + cache populate. Throws
 *   `JwksFetchError` on HTTP error or invalid JSON.
 * - `cacheGet(url)` — synchronous, returns null on miss OR on TTL expiry.
 *   NEVER returns a stale set (strict expire-on-read).
 * - `verify(jwt)` — Promise of a typed `VerifyResult`. NEVER throws.
 *   Internally falls back to `fetchJwks` on cache miss when configured with
 *   a fixed `jwksUrl`; without `jwksUrl` the caller must `fetchJwks` first.
 * - `refresh(url)` — force re-fetch, bypass cache.
 */
export interface JwksClient {
  fetchJwks(url: string): Promise<JwksSet>
  cacheGet(url: string): JwksSet | null
  verify(jwt: string): Promise<VerifyResult>
  refresh(url: string): Promise<JwksSet>
}
