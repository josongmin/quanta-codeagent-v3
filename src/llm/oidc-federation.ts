/**
 * ADR-0163 Phase C — OIDC federation token exchange.
 *
 * Claude CLI accepts a `ANTHROPIC_IDENTITY_TOKEN_FILE` env (pointing at a
 * file containing a workload-identity JWT — Kubernetes SA projection /
 * GitHub OIDC / Vault) and exchanges it for a short-lived Anthropic access
 * token via the federation endpoint. The exchange is parameterized by:
 *
 *   - `ANTHROPIC_IDENTITY_TOKEN_FILE`   path to the identity-token file
 *   - `ANTHROPIC_FEDERATION_RULE_ID`    federation rule id (which org binding)
 *   - `ANTHROPIC_ORGANIZATION_ID`       Anthropic org id (which billing account)
 *
 * The exchanged token's TTL is the vendor's TTL (we do NOT amplify it). The
 * file is read at every exchange (Kubernetes rotates the projection every
 * ~1h; we MUST re-read to pick up the new token, not cache the path).
 *
 * Closed-port discipline (hellgate-validated):
 *   - File read is `FileReaderPort.read(path) → Promise<string>` (no `node:fs`
 *     direct touch).
 *   - HTTP exchange is `HttpClientPort.post(url, body, headers)` (no `fetch`).
 *   - Clock is `ClockPort.now() → number` (no `Date.now()`).
 *
 * Pre-exchange validation (defense in depth — we refuse malformed input):
 *   - Token file size ≥ 100 bytes (real JWTs are 200+ B; <100 B is a sentinel
 *     for an empty file or a placeholder).
 *   - Token file size ≤ 64 KiB (anything larger is a runaway log file
 *     mistakenly pointed at).
 *   - Trimmed token must contain exactly 2 `.` separators (JWT 3-segment
 *     shape: header.payload.signature). We do NOT verify the signature.
 *
 * Default-OFF: the federation path activates ONLY when
 * `ANTHROPIC_IDENTITY_TOKEN_FILE` is set. Absent ⇒ the legacy
 * `ANTHROPIC_API_KEY` BYOK path stays exclusive.
 *
 * Plane-clean: imports leaf provider-types only. No SDK, no `@/agent`,
 * no `node:fs`.
 */

import type { ProviderCredentials } from "./provider-types"

/** Read-only env shape — same SSOT discipline as the router. */
export type OidcEnv = Record<string, string | undefined>

/** Read a file's contents as UTF-8 string. Single-method port — DIP. */
export interface FileReaderPort {
  read(path: string): Promise<string>
}

/** HTTP POST port — body is opaque JSON, headers are explicit. Returns the
 *  response body as parsed JSON. Single-method port — DIP. */
export interface HttpClientPort {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{
    status: number
    body: unknown
  }>
}

/** Clock port — `now()` returns ms since epoch. Single-method port — DIP. */
export interface ClockPort {
  now(): number
}

/** Exchange request parameters. The orgId is OPTIONAL — Anthropic federation
 *  rules can carry an implicit org binding, in which case the exchange picks
 *  the org from the rule itself. */
export interface ExchangeRequest {
  readonly identityTokenFile: string
  readonly federationRuleId: string
  readonly orgId?: string
}

/** Successful exchange result. `expiresAt` is ms-since-epoch (vendor TTL
 *  applied to the clock at exchange time). */
export interface ExchangeResult {
  readonly accessToken: string
  readonly expiresAt: number
  readonly credentials: ProviderCredentials
}

/** Closed error-code union. Adapters branch on `.code`, never on `.message`. */
export type OidcErrorCode =
  /** Token file path does not exist / cannot be read. */
  | "token-file-missing"
  /** Token file present but malformed (too small, too large, wrong shape). */
  | "token-file-malformed"
  /** Exchange endpoint returned a 4xx — caller bug (bad rule id, revoked
   *  federation, wrong org). Do NOT retry. */
  | "exchange-rejected"
  /** Exchange endpoint returned a 5xx — transient, caller MAY retry. */
  | "exchange-transient"
  /** Exchange endpoint response was missing required fields
   *  (`access_token` / `expires_in`). Vendor contract violation. */
  | "exchange-malformed-response"
  /** Required configuration was not supplied (caller bug). */
  | "exchange-misconfigured"

export class OidcFederationError extends Error {
  readonly code: OidcErrorCode
  readonly httpStatus?: number
  constructor(
    code: OidcErrorCode,
    message: string,
    options?: { httpStatus?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "OidcFederationError"
    this.code = code
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus
  }
}

/** Port surface — callers depend on this interface, not the concrete class. */
export interface OidcFederationPort {
  exchangeToken(req: ExchangeRequest): Promise<ExchangeResult>
}

/** Construction options for the default {@link OidcFederationExchanger}. */
export interface OidcFederationExchangerOptions {
  readonly fileReader: FileReaderPort
  readonly httpClient: HttpClientPort
  readonly clock: ClockPort
  /** Exchange endpoint base. Default-OFF posture: when absent we throw
   *  `exchange-misconfigured` so callers MUST opt in by passing the
   *  Anthropic federation endpoint explicitly. Test harnesses pass a mock
   *  URL pointing at a stub server. */
  readonly exchangeEndpointBase: string
}

/** Minimum/maximum bytes for the identity-token file. Documented constants —
 *  the "no heuristics" discipline requires we name the source: 100 B floor
 *  matches the smallest production JWT we have observed (signed with HS256
 *  and a 2-claim payload); 64 KiB ceiling matches the Kubernetes SA
 *  projection cap (`kube-apiserver --service-account-max-token-expiration`
 *  output never exceeds this). */
export const TOKEN_FILE_MIN_BYTES = 100
export const TOKEN_FILE_MAX_BYTES = 64 * 1024

/** Validate the identity-token bytes. Returns the trimmed token on success,
 *  throws {@link OidcFederationError} on failure. */
const validateTokenShape = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.length < TOKEN_FILE_MIN_BYTES) {
    throw new OidcFederationError(
      "token-file-malformed",
      `identity token file too small (${trimmed.length} bytes, minimum ${TOKEN_FILE_MIN_BYTES}) — empty or placeholder?`,
    )
  }
  if (trimmed.length > TOKEN_FILE_MAX_BYTES) {
    throw new OidcFederationError(
      "token-file-malformed",
      `identity token file too large (${trimmed.length} bytes, max ${TOKEN_FILE_MAX_BYTES}) — runaway log misrouted?`,
    )
  }
  // JWT 3-segment shape probe: exactly two `.` separators. We do NOT verify
  // the signature (that is the exchange endpoint's job).
  const dotCount = (trimmed.match(/\./g) ?? []).length
  if (dotCount !== 2) {
    throw new OidcFederationError(
      "token-file-malformed",
      `identity token not JWT-shaped (expected 2 '.' separators, found ${dotCount})`,
    )
  }
  return trimmed
}

/**
 * Reference {@link OidcFederationPort} implementation. All I/O via ports —
 * file read, HTTP, clock are all injected. The class holds NO state across
 * calls (every `exchangeToken` re-reads the file; we never cache the token
 * because Kubernetes rotates the projection independently of our refresh
 * timer).
 */
export class OidcFederationExchanger implements OidcFederationPort {
  private readonly fileReader: FileReaderPort
  private readonly httpClient: HttpClientPort
  private readonly clock: ClockPort
  private readonly exchangeEndpointBase: string

  constructor(options: OidcFederationExchangerOptions) {
    if (options.exchangeEndpointBase.length === 0) {
      throw new OidcFederationError(
        "exchange-misconfigured",
        "OidcFederationExchanger requires non-empty exchangeEndpointBase",
      )
    }
    this.fileReader = options.fileReader
    this.httpClient = options.httpClient
    this.clock = options.clock
    this.exchangeEndpointBase = options.exchangeEndpointBase
  }

  async exchangeToken(req: ExchangeRequest): Promise<ExchangeResult> {
    if (req.identityTokenFile.length === 0) {
      throw new OidcFederationError(
        "exchange-misconfigured",
        "identityTokenFile must be a non-empty path",
      )
    }
    if (req.federationRuleId.length === 0) {
      throw new OidcFederationError(
        "exchange-misconfigured",
        "federationRuleId must be a non-empty string",
      )
    }

    // Read the identity token. Re-read on every exchange — Kubernetes rotates
    // the projection on its own schedule.
    let raw: string
    try {
      raw = await this.fileReader.read(req.identityTokenFile)
    } catch (cause) {
      throw new OidcFederationError(
        "token-file-missing",
        `cannot read identity token file: ${req.identityTokenFile}`,
        { cause },
      )
    }

    const identityToken = validateTokenShape(raw)

    // POST to the federation exchange endpoint. Vendor surface is stable:
    // identity_token + federation_rule_id + optional organization_id.
    const url = `${this.exchangeEndpointBase}/v1/identity/federation/exchange`
    const body: Record<string, string> = {
      identity_token: identityToken,
      federation_rule_id: req.federationRuleId,
    }
    if (req.orgId !== undefined && req.orgId.length > 0) body.organization_id = req.orgId

    const response = await this.httpClient.post(url, body, {
      "content-type": "application/json",
      accept: "application/json",
    })

    if (response.status >= 500) {
      throw new OidcFederationError(
        "exchange-transient",
        `federation exchange returned ${response.status} (transient — retry permitted)`,
        { httpStatus: response.status },
      )
    }
    if (response.status >= 400) {
      throw new OidcFederationError(
        "exchange-rejected",
        `federation exchange rejected: HTTP ${response.status}`,
        { httpStatus: response.status },
      )
    }

    const parsed = response.body as { access_token?: unknown; expires_in?: unknown }
    if (typeof parsed?.access_token !== "string" || parsed.access_token.length === 0) {
      throw new OidcFederationError(
        "exchange-malformed-response",
        "federation exchange response missing access_token",
        { httpStatus: response.status },
      )
    }
    if (
      typeof parsed.expires_in !== "number" ||
      !Number.isFinite(parsed.expires_in) ||
      parsed.expires_in <= 0
    ) {
      throw new OidcFederationError(
        "exchange-malformed-response",
        "federation exchange response missing or invalid expires_in",
        { httpStatus: response.status },
      )
    }

    const expiresAt = this.clock.now() + parsed.expires_in * 1000
    return {
      accessToken: parsed.access_token,
      expiresAt,
      credentials: { kind: "oidc-federation", source: "file" },
    }
  }
}

/** Env-key constants for the federation triad. Exported so callers
 *  (`/login` UI, status panel, --help output) can render the canonical names
 *  without re-typing them. */
export const OIDC_ENV_KEYS = {
  identityTokenFile: "ANTHROPIC_IDENTITY_TOKEN_FILE",
  federationRuleId: "ANTHROPIC_FEDERATION_RULE_ID",
  orgId: "ANTHROPIC_ORGANIZATION_ID",
} as const

/** Read the federation triad from env. Returns `undefined` when the triad is
 *  not fully present (any required field missing). Pure function. */
export const readOidcEnv = (env: OidcEnv): ExchangeRequest | undefined => {
  const tokenFile = env[OIDC_ENV_KEYS.identityTokenFile]
  const ruleId = env[OIDC_ENV_KEYS.federationRuleId]
  if (tokenFile === undefined || tokenFile.length === 0) return undefined
  if (ruleId === undefined || ruleId.length === 0) return undefined
  const req: ExchangeRequest = { identityTokenFile: tokenFile, federationRuleId: ruleId }
  const orgId = env[OIDC_ENV_KEYS.orgId]
  if (orgId !== undefined && orgId.length > 0) {
    return { ...req, orgId }
  }
  return req
}
