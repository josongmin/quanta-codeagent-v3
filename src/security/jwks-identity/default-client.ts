/**
 * Default JWKS client (ADR-0248). Built-in `fetch` + TTL cache + Web Crypto
 * verify. RS256 + ES256 whitelist.
 *
 * Plane discipline: imports ONLY `globalThis.fetch` and `crypto.subtle` —
 * both available in Bun and Node ≥16. No other quanta slice.
 *
 * Determinism: the clock and the fetch implementation are both injectable
 * for tests. Defaults are `Date.now` and the global `fetch`.
 */

import type { JwksClient } from "./port"
import {
  type JsonWebKey,
  type JwksSet,
  JwksFetchError,
  type VerifyFailureReason,
  type VerifyResult,
} from "./types"

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour (Google / Cloudflare published)

/**
 * Optional configuration. All fields are nullable / defaulted — passing `{}`
 * is valid and uses real `fetch` + `Date.now` + 1h TTL.
 *
 * - `fetchImpl` — fetch override (tests, sidecar with custom transport).
 * - `clock` — clock override (tests). Returns ms since epoch.
 * - `ttlMs` — cache TTL window in ms. Default 3,600,000 (1h).
 * - `jwksUrl` — if set, `verify` will auto-fetch on cache miss. Without it,
 *   the caller must `fetchJwks` first; verify reports `cache-miss`.
 */
export interface DefaultJwksClientOpts {
  readonly fetchImpl?: typeof fetch
  readonly clock?: () => number
  readonly ttlMs?: number
  readonly jwksUrl?: string
}

/**
 * Construct a default JWKS client.
 *
 * The client closes over a private cache map (`url → JwksSet`). The cache
 * is strictly TTL-bounded: `cacheGet` returns null when
 * `clock() - fetchedAt >= ttlMs`, no background refresh, no stale serve.
 */
export function defaultJwksClient(opts: DefaultJwksClientOpts = {}): JwksClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const clock = opts.clock ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const jwksUrl = opts.jwksUrl
  const cache = new Map<string, JwksSet>()

  async function doFetch(url: string): Promise<JwksSet> {
    let resp: Response
    try {
      resp = await fetchImpl(url)
    } catch (err) {
      throw new JwksFetchError(
        `network error: ${(err as Error).message}`,
        url,
      )
    }
    if (!resp.ok) {
      throw new JwksFetchError(`HTTP ${resp.status}`, url)
    }
    let body: unknown
    try {
      body = await resp.json()
    } catch (err) {
      throw new JwksFetchError(
        `invalid JSON: ${(err as Error).message}`,
        url,
      )
    }
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { keys?: unknown }).keys)
    ) {
      throw new JwksFetchError("missing keys[] array", url)
    }
    const set: JwksSet = {
      keys: (body as { keys: ReadonlyArray<JsonWebKey> }).keys,
      fetchedAt: clock(),
      ttlMs,
    }
    cache.set(url, set)
    return set
  }

  function cacheGet(url: string): JwksSet | null {
    const hit = cache.get(url)
    if (!hit) return null
    if (clock() - hit.fetchedAt >= hit.ttlMs) {
      // Strict expire-on-read; do NOT serve stale. Clear the entry so a
      // subsequent re-fetch doesn't keep a stale shadow alive.
      cache.delete(url)
      return null
    }
    return hit
  }

  async function refresh(url: string): Promise<JwksSet> {
    cache.delete(url)
    return doFetch(url)
  }

  async function verify(jwt: string): Promise<VerifyResult> {
    return verifyImpl(jwt, {
      cacheGet,
      fetchJwks: doFetch,
      clock,
      jwksUrl,
    })
  }

  return {
    fetchJwks: doFetch,
    cacheGet,
    refresh,
    verify,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// verify chain — pure helpers + Web Crypto.
// ─────────────────────────────────────────────────────────────────────────

interface VerifyDeps {
  readonly cacheGet: (url: string) => JwksSet | null
  readonly fetchJwks: (url: string) => Promise<JwksSet>
  readonly clock: () => number
  readonly jwksUrl: string | undefined
}

async function verifyImpl(jwt: string, deps: VerifyDeps): Promise<VerifyResult> {
  const decoded = decodeJwt(jwt)
  if (!decoded) return fail("malformed-jwt")

  const { header, payload, signingInput, signature } = decoded
  if (typeof header.alg !== "string") return fail("malformed-jwt")
  if (header.alg !== "RS256" && header.alg !== "ES256") {
    return fail("unsupported-alg")
  }
  if (typeof header.kid !== "string") return fail("unknown-kid")

  // Locate a cached JWKS set. If the client is configured with a `jwksUrl`
  // and we have no cache entry, fall through to a single auto-fetch.
  let set: JwksSet | null = null
  if (deps.jwksUrl) {
    set = deps.cacheGet(deps.jwksUrl)
    if (!set) {
      try {
        set = await deps.fetchJwks(deps.jwksUrl)
      } catch {
        return fail("jwks-fetch-failed")
      }
    }
  } else {
    // No fixed URL — caller must have populated the cache via fetchJwks.
    // We scan all cached sets (rare path; mostly the fixed-URL flow is used).
    set = scanAnyCachedSet(deps.cacheGet, header.kid)
    if (!set) return fail("cache-miss")
  }

  const jwk = set.keys.find((k) => k.kid === header.kid)
  if (!jwk) return fail("unknown-kid")

  // Expiry check.
  if (typeof payload.exp === "number") {
    const nowSec = Math.floor(deps.clock() / 1000)
    if (payload.exp <= nowSec) return fail("expired")
  }

  // Crypto verify.
  try {
    const ok = await verifySignature(jwk, header.alg, signingInput, signature)
    if (!ok) return fail("signature-invalid")
  } catch {
    return fail("signature-invalid")
  }

  return { ok: true, kid: header.kid }
}

function fail(reason: VerifyFailureReason): VerifyResult {
  return { ok: false, reason }
}

/**
 * Last-resort cache scan when no fixed `jwksUrl` is configured. The default
 * caller always sets `jwksUrl`; this branch exists so a future multi-issuer
 * setup can pre-populate the cache and still hit the verify path.
 */
function scanAnyCachedSet(
  cacheGet: (url: string) => JwksSet | null,
  _kid: string,
): JwksSet | null {
  // We have no enumeration over private cache state from out here; the
  // hexagonal port is intentionally narrow. Multi-issuer callers should
  // create one client per issuer and pass `jwksUrl`. Returning null routes
  // these calls to `cache-miss`, which is the correct typed answer.
  void cacheGet
  return null
}

interface DecodedJwt {
  readonly header: { alg?: unknown; kid?: unknown }
  readonly payload: { exp?: number }
  readonly signingInput: string
  readonly signature: Uint8Array
}

function decodeJwt(jwt: string): DecodedJwt | null {
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  if (!h || !p || !s) return null
  let header: { alg?: unknown; kid?: unknown }
  let payload: { exp?: number }
  let signature: Uint8Array
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as {
      alg?: unknown
      kid?: unknown
    }
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as {
      exp?: number
    }
    signature = b64urlDecode(s)
  } catch {
    return null
  }
  return { header, payload, signingInput: `${h}.${p}`, signature }
}

function b64urlDecode(s: string): Uint8Array {
  // base64url → base64 + pad
  const norm = s.replace(/-/g, "+").replace(/_/g, "/")
  const pad = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4))
  const bin = atob(pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Import the JWK as a CryptoKey and verify the signature over `signingInput`.
 * Throws on invalid JWK shape — caller catches and reports
 * `signature-invalid`.
 */
async function verifySignature(
  jwk: JsonWebKey,
  alg: "RS256" | "ES256",
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const data = new TextEncoder().encode(signingInput)
  // Web Crypto `importKey("jwk", …)` expects a mutable JsonWebKey with
  // `key_ops?: string[]` (non-readonly). Our port type is `readonly`
  // (immutability is a port-side contract); we shallow-copy into a fresh
  // mutable object before handing it to the platform. `importKey` is an
  // overloaded function — referencing it as `subtle.importKey.call(subtle,
  // "jwk", …)` would type-check, but a positional call with an `any`-ish
  // cast on the JWK payload is the readable form here.
  const subtleJwk = {
    ...jwk,
    key_ops: jwk.key_ops ? [...jwk.key_ops] : undefined,
    // biome-ignore lint/suspicious/noExplicitAny: Web Crypto JsonWebKey
    // shape differs between lib.dom and @types/node; explicit any cast
    // narrowed to a single line keeps the boundary clean.
  } as any
  if (alg === "RS256") {
    const key = await crypto.subtle.importKey(
      "jwk",
      subtleJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, data)
  }
  // ES256
  const key = await crypto.subtle.importKey(
    "jwk",
    subtleJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    data,
  )
}
