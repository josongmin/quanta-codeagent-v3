/**
 * Connectors — type model + port contracts (ADR-0160 Phase A).
 *
 * Plane-clean: this slice imports only standard library types. No `@/agent`,
 * `@/permission`, `@/tool`, `@/llm` — connectors sit ABOVE `src/mcp/` (which is
 * unchanged) and wire into agent assembly only via separate follow-up ADR.
 *
 * SOTA references:
 *   - Codex Desktop `/aip/connectors` REST registry (server-driven catalog).
 *   - Cursor RFC-8414 OAuth discovery + RFC-7591 dynamic client registration.
 *   - Cursor per-host availability LRU.
 *   - Cursor `RefreshGithubAccessTokenInBackgroundComposer` token rotation.
 *
 * Every external dep is a typed port (`fetchPort`/`dnsPort`/`clockPort`/
 * `cachePort`/`tokenStore`) so the slice is DI-driven end-to-end.
 */

// ────────────────────────────────────────────────────────────────────────────
// Connector model — closed unions per OCP discipline.
// ────────────────────────────────────────────────────────────────────────────

/** Closed union — adding an auth scheme forces a sweep over every switch. */
export type SupportedAuth = "oauth" | "none"

/**
 * Server-published connector descriptor. Stable within ONE registry snapshot.
 * `oauthIssuer` is REQUIRED iff `auth === "oauth"` (caller branches on `auth`
 * before reading `oauthIssuer`).
 *
 * exactOptionalPropertyTypes: omitted optional fields MUST be absent, never
 * `undefined`-set. Compose with conditional spreads.
 */
export interface Connector {
  /** Stable identifier within one registry snapshot. */
  readonly id: string
  /** Human-readable label for UI surfaces. */
  readonly displayName: string
  /** Canonical reachable host (used by AvailabilityCheckerPort). */
  readonly host: string
  /** Authentication scheme — closed union. */
  readonly auth: SupportedAuth
  /** OAuth issuer URL. Present iff `auth === "oauth"`. */
  readonly oauthIssuer?: string
  /** Optional tag list — caller-defined semantics. */
  readonly tags?: ReadonlyArray<string>
}

// ────────────────────────────────────────────────────────────────────────────
// Registry port — REST/in-memory adapters share this surface.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Outcome of `ConnectorRegistryPort.refresh()`. Stable arm so callers branch
 * without parsing strings.
 *
 *  - `"fresh"`            : server returned a fresh catalog, cache updated.
 *  - `"cached-degraded"`  : server unreachable / 5xx, stale cache served.
 *                            **Honesty contract**: caller knows it is stale.
 *  - `"cached-fresh"`     : cache TTL still valid, no network call performed.
 */
export type RefreshOutcome = "fresh" | "cached-degraded" | "cached-fresh"

/** The connector registry surface — REST adapter + in-memory test impl share. */
export interface ConnectorRegistryPort {
  list(): Promise<ReadonlyArray<Connector>>
  get(id: string): Promise<Connector | undefined>
  /** Trigger an explicit refresh. Returns typed outcome (no throw). */
  refresh(): Promise<RefreshOutcome>
}

// ────────────────────────────────────────────────────────────────────────────
// Availability port — typed verdict arm.
// ────────────────────────────────────────────────────────────────────────────

/** Closed verdict union — every callsite must branch exhaustively. */
export type AvailabilityVerdict = "ok" | "dns-fail" | "http-fail" | "timeout"

export interface AvailabilityCheckerPort {
  probe(host: string): Promise<AvailabilityVerdict>
}

// ────────────────────────────────────────────────────────────────────────────
// Injected ports — fetch, DNS, clock, cache, token store.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal fetch surface — what the connectors slice needs. NEVER imports
 * `globalThis.fetch` at slice top-level; callers inject (real fetch in prod,
 * fake in tests).
 */
export type FetchPort = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<FetchPortResponse>

export interface FetchPortResponse {
  readonly status: number
  readonly ok: boolean
  text(): Promise<string>
}

/** DNS resolution surface — `address` array nonempty iff resolution succeeded. */
export interface DnsPort {
  resolve(host: string): Promise<ReadonlyArray<string>>
}

/** Monotonic clock surface — returns ms since epoch. Tests inject a virtual clock. */
export interface ClockPort {
  now(): number
}

/**
 * Cache surface for the REST registry. Stores opaque blobs keyed by string.
 * File-backed in prod, in-memory in test — symmetric DI.
 */
export interface CachePort {
  read(key: string): Promise<CacheEntry | undefined>
  write(key: string, entry: CacheEntry): Promise<void>
}

export interface CacheEntry {
  readonly value: string
  /** Wall-clock ms when this entry was written. Used by TTL check. */
  readonly writtenAt: number
}

// ────────────────────────────────────────────────────────────────────────────
// Token store + rotation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-connector token record. `expiresAt` is wall-clock ms or omitted if the
 * token has no expiry (e.g. opaque refresh-only).
 */
export interface TokenRecord {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  /** Token type — usually "Bearer". Closed by caller convention. */
  readonly tokenType: string
}

export interface TokenStorePort {
  read(connectorId: string): Promise<TokenRecord | undefined>
  write(connectorId: string, record: TokenRecord): Promise<void>
  delete(connectorId: string): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Typed errors — stable `code` arm so callers branch without string parse.
// ────────────────────────────────────────────────────────────────────────────

export type OAuthDiscoveryErrorCode =
  | "well-known-404"
  | "well-known-malformed"
  | "missing-required-field"
  | "network-failed"

export class OAuthDiscoveryError extends Error {
  readonly code: OAuthDiscoveryErrorCode
  constructor(code: OAuthDiscoveryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "OAuthDiscoveryError"
    this.code = code
  }
}

export type OAuthRegistrationErrorCode =
  | "registration-rejected"
  | "registration-malformed"
  | "missing-client-id"
  | "network-failed"

export class OAuthRegistrationError extends Error {
  readonly code: OAuthRegistrationErrorCode
  constructor(code: OAuthRegistrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "OAuthRegistrationError"
    this.code = code
  }
}

export type TokenRotationErrorCode =
  | "store-write-failed"
  | "refresh-callback-failed"
  | "missing-token"

export class TokenRotationError extends Error {
  readonly code: TokenRotationErrorCode
  constructor(code: TokenRotationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "TokenRotationError"
    this.code = code
  }
}
