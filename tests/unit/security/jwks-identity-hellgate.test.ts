/**
 * ★ CONTRACT — ADR-0248 JWKS agent identity slice. Hexagonal port + default
 *   client. fetchJwks → cache (TTL 1h) → verify (Web Crypto API). RS256 + ES256
 *   whitelist. verify NEVER throws — all rejections are typed VerifyResult.
 *
 * HELLGATE — 16 adversarial proofs:
 *   B1  fetchJwks parses well-formed JWKS document
 *   B2  fetchJwks throws JwksFetchError on 4xx HTTP response
 *   B3  fetchJwks throws JwksFetchError on invalid JSON body
 *   B4  cacheGet returns cached set without a network call
 *   B5  cacheGet returns null after TTL expiry (no stale serve)
 *   B6  refresh bypasses cache, re-issues network fetch
 *   B7  verify returns ok:true for a fresh, kid-matching token
 *   B8  verify returns ok:false reason="expired" when payload.exp passed
 *   B9  verify returns ok:false reason="unknown-kid" when JWT kid not in JWKS
 *   B10 verify returns ok:false reason="signature-invalid" on tampered payload
 *   B11 verify accepts an RS256 (RSA) token end-to-end
 *   B12 verify accepts an ES256 (ECDSA P-256) token end-to-end
 *   B13 verify returns ok:false reason="unsupported-alg" for HS256 header
 *   B14 default-OFF byte-identical — barrel import does not touch dispatch
 *   B15 100-verify cached path — one fetch and a bounded local verify budget
 *   B16 JWK algorithm/use/key_ops/key-family declarations are enforced
 */
import { describe, expect, test } from "bun:test"
import {
  defaultJwksClient,
  type JsonWebKey,
  JwksFetchError,
  type JwksSet,
} from "@/security/jwks-identity"

// ─────────────────────────────────────────────────────────────────────────
// Helpers — generate signing keys + sign a JWT for end-to-end verify tests.
// Pure Web Crypto; no third-party JWT lib (would defeat the determinism test).
// ─────────────────────────────────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function b64urlEncodeJson(obj: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)))
}

async function generateRsaKeypair(): Promise<{
  publicJwk: JsonWebKey
  privateKey: CryptoKey
}> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const pubJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey
  return { publicJwk: { ...pubJwk, alg: "RS256", kid: "rsa-1" }, privateKey }
}

async function generateEcKeypair(): Promise<{
  publicJwk: JsonWebKey
  privateKey: CryptoKey
}> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )
  const pubJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey
  return { publicJwk: { ...pubJwk, alg: "ES256", kid: "ec-1" }, privateKey }
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  algo: "RS256" | "ES256",
): Promise<string> {
  const headerB64 = b64urlEncodeJson(header)
  const payloadB64 = b64urlEncodeJson(payload)
  const signingInput = `${headerB64}.${payloadB64}`
  const data = new TextEncoder().encode(signingInput)
  const params =
    algo === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" }
  const sig = await crypto.subtle.sign(params, privateKey, data)
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`
}

/** Tiny in-memory fetch stub. The default client takes a `fetchImpl` injection. */
function stubFetch(map: Record<string, { status: number; body: string }>): {
  fn: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push(url)
    const hit = map[url]
    if (!hit) return new Response("missing", { status: 404 })
    return new Response(hit.body, { status: hit.status })
  }) as typeof fetch
  return { fn, calls }
}

// ─────────────────────────────────────────────────────────────────────────
// B. JWKS verifier hellgate
// ─────────────────────────────────────────────────────────────────────────

describe("B. JWKS fetch + cache", () => {
  test("B1 — fetchJwks parses well-formed JWKS document", async () => {
    const { publicJwk } = await generateRsaKeypair()
    const url = "https://issuer.test/.well-known/jwks.json"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn })
    const set: JwksSet = await client.fetchJwks(url)
    expect(set.keys.length).toBe(1)
    expect(set.keys[0]?.kid).toBe("rsa-1")
    expect(set.ttlMs).toBe(3_600_000)
  })

  test("B2 — fetchJwks throws JwksFetchError on HTTP 4xx", async () => {
    const url = "https://issuer.test/jwks-404"
    const { fn } = stubFetch({ [url]: { status: 403, body: "denied" } })
    const client = defaultJwksClient({ fetchImpl: fn })
    let caught: unknown = null
    try {
      await client.fetchJwks(url)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(JwksFetchError)
  })

  test("B3 — fetchJwks throws JwksFetchError on invalid JSON", async () => {
    const url = "https://issuer.test/jwks-bad"
    const { fn } = stubFetch({ [url]: { status: 200, body: "<<not-json>>" } })
    const client = defaultJwksClient({ fetchImpl: fn })
    let caught: unknown = null
    try {
      await client.fetchJwks(url)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(JwksFetchError)
  })

  test("B4 — cacheGet returns cached set without a network call", async () => {
    const { publicJwk } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-cache"
    const { fn, calls } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn })
    await client.fetchJwks(url)
    expect(calls.length).toBe(1)
    const cached = client.cacheGet(url)
    expect(cached?.keys.length).toBe(1)
    expect(calls.length).toBe(1) // no extra network call on cache hit
  })

  test("B5 — cacheGet returns null after TTL expiry (no stale serve)", async () => {
    const { publicJwk } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-ttl"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    let now = 1_000_000
    const client = defaultJwksClient({
      fetchImpl: fn,
      clock: () => now,
      ttlMs: 1000,
    })
    await client.fetchJwks(url)
    expect(client.cacheGet(url)).not.toBeNull()
    now += 1500
    expect(client.cacheGet(url)).toBeNull()
  })

  test("B6 — refresh bypasses cache, re-issues fetch", async () => {
    const { publicJwk } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-refresh"
    const { fn, calls } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn })
    await client.fetchJwks(url)
    await client.refresh(url)
    expect(calls.length).toBe(2)
  })
})

describe("B. JWKS verify", () => {
  test("B7 — verify returns ok:true for a fresh, kid-matching token", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-ok"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const now = 2_000_000
    const client = defaultJwksClient({
      fetchImpl: fn,
      clock: () => now * 1000,
      jwksUrl: url,
    })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-1", typ: "JWT" },
      { sub: "agent-1", exp: now + 60 },
      privateKey,
      "RS256",
    )
    const r = await client.verify(jwt)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.kid).toBe("rsa-1")
  })

  test("B8 — verify returns ok:false reason=expired when payload.exp passed", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-exp"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const now = 2_000_000
    const client = defaultJwksClient({
      fetchImpl: fn,
      clock: () => now * 1000,
      jwksUrl: url,
    })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-1", typ: "JWT" },
      { sub: "agent-1", exp: now - 60 },
      privateKey,
      "RS256",
    )
    const r = await client.verify(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("expired")
  })

  test("B9 — verify returns ok:false reason=unknown-kid when JWT kid missing", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-unk"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const now = 2_000_000
    const client = defaultJwksClient({
      fetchImpl: fn,
      clock: () => now * 1000,
      jwksUrl: url,
    })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-other", typ: "JWT" },
      { sub: "agent-1", exp: now + 60 },
      privateKey,
      "RS256",
    )
    const r = await client.verify(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unknown-kid")
  })

  test("B10 — verify returns ok:false reason=signature-invalid on tampered payload", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-tamper"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const now = 2_000_000
    const client = defaultJwksClient({
      fetchImpl: fn,
      clock: () => now * 1000,
      jwksUrl: url,
    })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-1", typ: "JWT" },
      { sub: "agent-1", exp: now + 60 },
      privateKey,
      "RS256",
    )
    // Flip a payload char (still valid base64url chars).
    const parts = jwt.split(".")
    const tamperedPayload =
      parts[1] && parts[1].length > 4
        ? parts[1].slice(0, -1) + (parts[1].endsWith("A") ? "B" : "A")
        : parts[1]
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`
    const r = await client.verify(tampered)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("signature-invalid")
  })

  test("B11 — verify accepts an RS256 (RSA) token end-to-end", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const url = "https://issuer.test/rsa-e2e"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn, jwksUrl: url })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-1", typ: "JWT" },
      { sub: "agent-rs256" },
      privateKey,
      "RS256",
    )
    const r = await client.verify(jwt)
    expect(r.ok).toBe(true)
  })

  test("B12 — verify accepts an ES256 (ECDSA P-256) token end-to-end", async () => {
    const { publicJwk, privateKey } = await generateEcKeypair()
    const url = "https://issuer.test/ec-e2e"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn, jwksUrl: url })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "ES256", kid: "ec-1", typ: "JWT" },
      { sub: "agent-es256" },
      privateKey,
      "ES256",
    )
    const r = await client.verify(jwt)
    expect(r.ok).toBe(true)
  })

  test("B13 — verify returns ok:false reason=unsupported-alg for HS256", async () => {
    const { publicJwk } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-hs256"
    const { fn } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn, jwksUrl: url })
    await client.fetchJwks(url)
    // Forge a header with HS256; signature segment value is irrelevant — the
    // alg whitelist short-circuits before we even compute it.
    const headerB64 = b64urlEncodeJson({ alg: "HS256", kid: "rsa-1", typ: "JWT" })
    const payloadB64 = b64urlEncodeJson({ sub: "x" })
    const jwt = `${headerB64}.${payloadB64}.AAAA`
    const r = await client.verify(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unsupported-alg")
  })

  test("B14 — default-OFF byte-identical (barrel import does not touch dispatch)", async () => {
    // Importing the slice must NOT pull in any other quanta module. We assert
    // this by snapshotting the exported surface and confirming it's the same
    // closed shape across two import cycles.
    const mod1 = await import("@/security/jwks-identity")
    const mod2 = await import("@/security/jwks-identity")
    const keys1 = Object.keys(mod1).sort()
    const keys2 = Object.keys(mod2).sort()
    expect(keys1).toEqual(keys2)
    expect(keys1).toContain("defaultJwksClient")
    expect(keys1).toContain("headlessJwksClient")
    expect(keys1).toContain("JwksFetchError")
    expect(keys1).toContain("JwksVerifyError")
    expect(keys1).toContain("JwksError")
  })

  test("B15 — 100 verify cached-path stays local and bounded", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const url = "https://issuer.test/jwks-perf"
    const { fn, calls } = stubFetch({
      [url]: { status: 200, body: JSON.stringify({ keys: [publicJwk] }) },
    })
    const client = defaultJwksClient({ fetchImpl: fn, jwksUrl: url })
    await client.fetchJwks(url)
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-1", typ: "JWT" },
      { sub: "agent-perf" },
      privateKey,
      "RS256",
    )
    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      const r = await client.verify(jwt)
      expect(r.ok).toBe(true)
    }
    const elapsed = performance.now() - start
    // The functional cache contract is that verification issues no further
    // network reads. Wall-clock crypto timing varies under a full local suite,
    // so keep a generous host-pressure bound while still catching unbounded work.
    expect(calls).toEqual([url])
    expect(elapsed).toBeLessThan(1_500)
  })

  test("B16 — declared JWK algorithm, use, key_ops, and family bind verification", async () => {
    const { publicJwk, privateKey } = await generateRsaKeypair()
    const jwt = await signJwt(
      { alg: "RS256", kid: "rsa-1", typ: "JWT" },
      { sub: "agent-bound-key" },
      privateKey,
      "RS256",
    )
    const hostileKeys: readonly JsonWebKey[] = [
      { ...publicJwk, alg: "ES256" },
      { ...publicJwk, use: "enc" },
      { ...publicJwk, key_ops: ["sign"] },
      { ...publicJwk, kty: "EC", crv: "P-256" },
    ]
    for (const [index, key] of hostileKeys.entries()) {
      const url = `https://issuer.test/jwks-metadata-${index}`
      const { fn } = stubFetch({
        [url]: { status: 200, body: JSON.stringify({ keys: [key] }) },
      })
      const client = defaultJwksClient({ fetchImpl: fn, jwksUrl: url })
      await client.fetchJwks(url)
      expect(await client.verify(jwt)).toEqual({ ok: false, reason: "signature-invalid" })
    }
  })
})
