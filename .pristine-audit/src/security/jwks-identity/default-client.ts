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

import { errMessage } from "@/shared"
import type { JwksClient } from "./port"
import {
  type JsonWebKey,
  JwksFetchError,
  type JwksSet,
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
      throw new JwksFetchError(`network error: ${errMessage(err)}`, url)
    }
    if (!resp.ok) {
      throw new JwksFetchError(`HTTP ${resp.status}`, url)
    }
    let body: unknown
    try {
      body = await resp.json()
    } catch (err) {
      throw new JwksFetchError(`invalid JSON: ${errMessage(err)}`, url)
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as { keys?: unknown }).keys)) {
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

type ParsedHeader = { alg: "RS256" | "ES256"; kid: string }
type HeaderResult = { ok: true; header: ParsedHeader } | { ok: false; reason: VerifyFailureReason }

function validateHeader(rawHeader: { alg?: unknown; kid?: unknown }): HeaderResult {
  if (typeof rawHeader.alg !== "string") return { ok: false, reason: "malformed-jwt" }
  if (rawHeader.alg !== "RS256" && rawHeader.alg !== "ES256") {
    return { ok: false, reason: "unsupported-alg" }
  }
  if (typeof rawHeader.kid !== "string") return { ok: false, reason: "unknown-kid" }
  return { ok: true, header: { alg: rawHeader.alg, kid: rawHeader.kid } }
}

async function resolveJwksSet(deps: VerifyDeps): Promise<JwksSet | VerifyFailureReason> {
  if (!deps.jwksUrl) {
    return "cache-miss"
  }
  const cached = deps.cacheGet(deps.jwksUrl)
  if (cached) return cached
  try {
    return await deps.fetchJwks(deps.jwksUrl)
  } catch {
    return "jwks-fetch-failed"
  }
}

async function verifyImpl(jwt: string, deps: VerifyDeps): Promise<VerifyResult> {
  const decoded = decodeJwt(jwt)
  if (!decoded) return fail("malformed-jwt")
  const { header: rawHeader, payload, signingInput, signature } = decoded

  const headerResult = validateHeader(rawHeader)
  if (!headerResult.ok) return fail(headerResult.reason)
  const { alg, kid } = headerResult.header

  const setOrReason = await resolveJwksSet(deps)
  if (typeof setOrReason === "string") return fail(setOrReason)
  const set = setOrReason

  const jwk = set.keys.find((k) => k.kid === kid)
  if (!jwk) return fail("unknown-kid")
  // A matching `kid` alone is not authority to use a key for this signature.
  // Bind the header algorithm to the JWK declaration, reject keys explicitly
  // marked for encryption/non-verification, and require the matching key
  // family before handing untrusted metadata to Web Crypto.
  if (!jwkPermitsSignatureVerification(jwk, alg)) return fail("signature-invalid")

  if (typeof payload.exp === "number") {
    const nowSec = Math.floor(deps.clock() / 1000)
    if (payload.exp <= nowSec) return fail("expired")
  }

  try {
    const ok = await verifySignature(jwk, alg, signingInput, signature)
    if (!ok) return fail("signature-invalid")
  } catch {
    return fail("signature-invalid")
  }
  return { ok: true, kid }
}

function fail(reason: VerifyFailureReason): VerifyResult {
  return { ok: false, reason }
}

const jwkPermitsSignatureVerification = (jwk: JsonWebKey, alg: "RS256" | "ES256"): boolean => {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false
  if (jwk.use !== undefined && jwk.use !== "sig") return false
  if (jwk.key_ops !== undefined) {
    if (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")) return false
  }
  return alg === "RS256" ? jwk.kty === "RSA" : jwk.kty === "EC" && jwk.crv === "P-256"
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
  let signature: Uint8Array
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as {
      alg?: unknown
      kid?: unknown
    }
    signature = b64urlDecode(s)
  } catch {
    return null
  }
  // Payload JSON parse failure is non-fatal — a tampered payload that no
  // longer parses must still surface as `signature-invalid` (the actual
  // tamper signal), not `malformed-jwt`. We expose an empty payload so
  // the exp check is skipped; signature verify is the authoritative gate.
  let payload: { exp?: number } = {}
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as {
      exp?: number
    }
  } catch {
    payload = {}
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
 * Loose structural shape of a JWK as accepted by `crypto.subtle.importKey`.
 * The lib.dom typing exports `JsonWebKey` and @types/node exports
 * `webcrypto.JsonWebKey`; both expect MUTABLE arrays whereas our port type
 * is `readonly`. Declaring a local non-readonly mirror lets us shallow-copy
 * into the platform shape without an `any` escape hatch.
 */
interface SubtleJwk {
  kty: string
  alg?: string
  kid?: string
  use?: string
  key_ops?: string[]
  x5u?: string
  x5c?: string[]
  x5t?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
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
  // Shallow-copy the readonly port shape into a mutable platform shape.
  const subtleJwk: SubtleJwk = {
    kty: jwk.kty,
    ...(jwk.alg !== undefined && { alg: jwk.alg }),
    ...(jwk.kid !== undefined && { kid: jwk.kid }),
    ...(jwk.use !== undefined && { use: jwk.use }),
    ...(jwk.key_ops !== undefined && { key_ops: [...jwk.key_ops] }),
    ...(jwk.x5u !== undefined && { x5u: jwk.x5u }),
    ...(jwk.x5c !== undefined && { x5c: [...jwk.x5c] }),
    ...(jwk.x5t !== undefined && { x5t: jwk.x5t }),
    ...(jwk.n !== undefined && { n: jwk.n }),
    ...(jwk.e !== undefined && { e: jwk.e }),
    ...(jwk.crv !== undefined && { crv: jwk.crv }),
    ...(jwk.x !== undefined && { x: jwk.x }),
    ...(jwk.y !== undefined && { y: jwk.y }),
  }
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
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data)
}
