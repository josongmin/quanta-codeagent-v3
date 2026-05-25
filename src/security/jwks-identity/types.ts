/**
 * JWKS agent identity — type primitives (ADR-0248).
 *
 * Plane discipline: imports nothing outside its own directory. Pure data
 * shapes + closed error classes.
 */

/**
 * RFC 7517 JSON Web Key. Closed shape over the fields v3 supports today
 * (RS256 + ES256). `x5u` / `x5c` / `x5t` are preserved for future chain
 * validation but unused by the default verifier. `n`/`e` populate for RSA
 * (`kty:"RSA"`); `crv`/`x`/`y` populate for EC (`kty:"EC"`).
 *
 * `kty` and `alg` are required because the default client switches on both.
 * `kid` is required for cache lookup — a JWK without a kid cannot be
 * addressed from a JWT header.
 */
export interface JsonWebKey {
  readonly kty: string
  readonly alg?: string
  readonly kid?: string
  readonly use?: string
  readonly key_ops?: ReadonlyArray<string>
  readonly x5u?: string
  readonly x5c?: ReadonlyArray<string>
  readonly x5t?: string
  // RSA
  readonly n?: string
  readonly e?: string
  // EC
  readonly crv?: string
  readonly x?: string
  readonly y?: string
}

/**
 * Cached JWKS document. `fetchedAt` is a millisecond timestamp from the
 * client's injected clock; `ttlMs` is the configured cache window.
 */
export interface JwksSet {
  readonly keys: ReadonlyArray<JsonWebKey>
  readonly fetchedAt: number
  readonly ttlMs: number
}

/**
 * Closed set of reasons a verify call can fail. Discriminator literals —
 * a caller exhaustively switches over this without leaving room for
 * heuristic interpretation.
 */
export type VerifyFailureReason =
  | "expired"
  | "unknown-kid"
  | "signature-invalid"
  | "malformed-jwt"
  | "unsupported-alg"
  | "jwks-fetch-failed"
  | "cache-miss"

/**
 * Discriminated verify outcome. `verify` NEVER throws — callers always
 * receive a typed result.
 */
export type VerifyResult =
  | { readonly ok: true; readonly kid: string }
  | { readonly ok: false; readonly reason: VerifyFailureReason }

/**
 * Base error for JWKS operations. `fetchJwks` / `refresh` MAY throw a
 * subclass on network or parse failure; `verify` translates these to a
 * typed `{ ok: false, reason: "jwks-fetch-failed" }`.
 */
export class JwksError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JwksError"
  }
}

/**
 * Network or parse failure during a JWKS fetch.
 */
export class JwksFetchError extends JwksError {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message)
    this.name = "JwksFetchError"
  }
}

/**
 * Crypto error during key import or signature verify. The default client
 * catches these and reports a typed VerifyResult — this class exists for
 * callers that wish to extend the slice.
 */
export class JwksVerifyError extends JwksError {
  constructor(message: string) {
    super(message)
    this.name = "JwksVerifyError"
  }
}
