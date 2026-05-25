# ADR-0248: JWKS agent identity — remote JWK fetch + cache + verify

- Status: Accepted
- Date: 2026-05-25
- SOTA reference: RFC 7517 (JSON Web Key), RFC 7518 (JSON Web Algorithms),
  RFC 7515 (JSON Web Signature), Google's published OIDC JWKS endpoint
  (`https://www.googleapis.com/oauth2/v3/certs`), Cloud Run service-to-service
  ID-token verification, Cloudflare Access JWT verification flow. The Codex
  "agent task" registration path fetches a remote JWKS endpoint to discover
  the signing keys the dispatcher will then use to verify per-task identity
  tokens; this slice closes the **verify-only** half of that pattern.
- Sibling slice: ADR-0164 secret-detection / ADR-0168 PII-redaction (both
  default-OFF security primitives consumed by future callers, not the runtime
  dispatch seam). Future siblings: signing (private-key custody + JWS sign),
  Cloud Tasks dispatch wiring, realtime auth wire — all explicit
  `deliberate_hold`.

## Context

When v3 starts registering agent tasks with an external dispatcher (Codex
JSON-RPC, Cloud Tasks, a partner orchestrator), the dispatcher hands back a
signed identity token (JWT). The agent host needs to verify that token before
acting on a directive — otherwise any caller can forge a "scheduled
follow-up" or a "reviewer dispatch" envelope and the agent will execute it.

The canonical way to do this without per-task pre-shared secrets is:

1. The dispatcher publishes a JWKS endpoint (a JSON document with a `keys[]`
   array of JWK objects, RFC 7517).
2. The verifier fetches that document, caches it for a bounded TTL, and
   selects the JWK whose `kid` matches the JWT's `kid` header.
3. The verifier reconstructs a public CryptoKey from the JWK and validates
   the JWS signature using `crypto.subtle.verify`.

Three constraints shape the slice:

- **Verify-only.** No signing today. Signing requires private-key custody
  decisions (HSM? file? keychain?) and we explicitly defer that to a follow-up
  slice. This ADR ships the *consumer* half — verify a remote-issued token.
- **No new runtime dependencies.** Bun + Node ≥16 expose Web Crypto API
  (`crypto.subtle`) and built-in `fetch`. RSA (RS256) and ECDSA (ES256/P-256)
  cover ~all real-world JWKS endpoints; the rarer EdDSA/HS256/RS384/RS512
  are out of scope and report a typed `unsupported-alg`.
- **Default-OFF.** Nothing in `src/agent/**`, `src/runner/**`, `src/scheduler/**`,
  or any dispatch seam imports this today. The slice is dormant until a future
  caller (agent-task registrar, realtime auth, scheduler webhook) opts in.

Neither v3 nor any absorbed agent (Codex, Claude Desktop, Cursor) ships a
typed, default-OFF JWKS verifier the loop can opt into. The Codex Anthropic
SDK trigger path (`anthropic-sdk-in-codex` memory note) confirms identity
verification is currently a Sentry-side concern — not a quanta primitive.

## Decision

A new hexagonal slice under `src/security/jwks-identity/`:

```
port.ts              — JsonWebKey, JwksSet, VerifyResult, JwksError, JwksClient.
default-client.ts    — built-in fetch + TTL cache 1h + Web Crypto verify.
headless-stub.ts     — typed no-op for surfaces that explicitly skip JWKS.
index.ts             — barrel.
```

### Port shape

- `JsonWebKey` = `{ kty, alg, kid, x5u?, x5c?, x5t?, n?, e?, crv?, x?, y? }`.
  Covers RSA (`kty: "RSA"`, fields `n` + `e`) and EC (`kty: "EC"`, fields
  `crv` + `x` + `y`); the optional `x5u`/`x5c`/`x5t` chain fields are
  preserved for callers that downstream them (none today).
- `JwksSet` = `{ keys: ReadonlyArray<JsonWebKey>, fetchedAt: number, ttlMs: number }`.
- `VerifyResult` = discriminated `{ ok: true, kid }` | `{ ok: false, reason }`
  where `reason` is a closed string union (`"expired"` / `"unknown-kid"` /
  `"signature-invalid"` / `"malformed-jwt"` / `"unsupported-alg"` /
  `"jwks-fetch-failed"` / `"cache-miss"`).
- `JwksError` = base class extended by `JwksFetchError` (HTTP / parse) and
  `JwksVerifyError` (crypto). Errors are thrown from `fetchJwks` /
  `refresh`; the `verify` method NEVER throws and always returns a typed
  `VerifyResult`.
- `JwksClient` carries four methods:
  - `fetchJwks(url): Promise<JwksSet>` — network fetch + parse + populate cache.
  - `cacheGet(url): JwksSet | null` — returns null on miss OR on TTL expire.
  - `verify(jwt): Promise<VerifyResult>` — never throws.
  - `refresh(url): Promise<JwksSet>` — force re-fetch, bypass cache.

### Default client

- TTL 1h (mirrors Google / Cloudflare published values).
- `cacheGet` returns null when `Date.now() - fetchedAt >= ttlMs` — strictly
  expire-on-read, no background refresh thread (keeps the slice portable to a
  Tauri sidecar or worker thread).
- `verify` chain: decode JWT segments → look up `kid` in cache for the
  configured JWKS URL → reconstruct CryptoKey via `crypto.subtle.importKey`
  with the JWK as input → verify signature over `${headerB64}.${payloadB64}`.
- Algorithm whitelist: `RS256` (RSASSA-PKCS1-v1_5 + SHA-256) and `ES256`
  (ECDSA P-256 + SHA-256). Anything else → `unsupported-alg`.
- Expiry check: payload `exp` (seconds since epoch) compared against the
  injectable `clock()` (defaults to `Date.now()`). Missing `exp` is OK
  (callers that need a hard expire wrap a Joi-style validator on the payload).

### Plane discipline

The slice imports ONLY Web Crypto API (`crypto.subtle` — global in Bun and
Node ≥16) and `globalThis.fetch`. No `@/shared`, no `@/permission`, no
other quanta slice. Keeps the verifier portable.

### Default-OFF

Nothing in `src/agent/**`, `src/runner/**`, `src/tool/**`, `src/scheduler/**`,
or `src/realtime/**` imports `src/security/jwks-identity/**`. The slice is
dormant until a caller opts in — same posture as ADR-0164 secret-detection
and ADR-0168 PII redaction.

## Deliberate hold

- **Signing.** Producing a JWS over a payload (e.g. attesting an agent
  identity to a downstream service) requires private-key custody decisions
  (file? HSM? OS keychain? sidecar?). Out of scope; future sibling slice.
- **Cloud Tasks integration.** The verify slice will gate Cloud Tasks
  callbacks once that wiring lands; not in this ADR.
- **Realtime auth wire.** The realtime / SSE auth path will consume this
  verifier when surface auth is added; not in this ADR.

## Negative invariants

- The verifier NEVER throws on bad input — all rejection paths return
  `{ ok: false, reason }`. A throw is a bug.
- `fetchJwks` / `refresh` MAY throw `JwksFetchError` (network / parse) —
  verify wraps these as `{ ok: false, reason: "jwks-fetch-failed" }`.
- Cache lookups MUST be strictly TTL-bounded (no "best effort" stale serve).
  A stale read is a security regression.
- The slice MUST NOT import any other quanta slice — boundary scanner gate.
