/**
 * OAuth endpoint discovery (ADR-0160 Phase C).
 *
 * Implements RFC 8414 §3 well-known discovery with OIDC fallback:
 *   1. GET `{issuer}/.well-known/oauth-authorization-server` (RFC 8414).
 *   2. On 404, fallback to `{issuer}/.well-known/openid-configuration` (OIDC §4).
 *
 * Returns a typed `OAuthEndpoints` record. Throws `OAuthDiscoveryError` with a
 * stable `code` arm — callers branch without string-matching.
 */

import { type FetchPort, OAuthDiscoveryError } from "./types"

export interface OAuthEndpoints {
  readonly authorizeEndpoint: string
  readonly tokenEndpoint: string
  /** Present iff the IdP advertises dynamic client registration (RFC 7591). */
  readonly registrationEndpoint?: string
}

/** Strip trailing slash from an issuer URL — well-known suffix appends its own. */
const normalizeIssuer = (issuer: string): string => issuer.replace(/\/+$/, "")

/** Try to extract endpoints from a parsed well-known document. */
const extractEndpoints = (doc: unknown): OAuthEndpoints | undefined => {
  if (typeof doc !== "object" || doc === null) return undefined
  const o = doc as Record<string, unknown>
  const authorizeEndpoint = o.authorization_endpoint
  const tokenEndpoint = o.token_endpoint
  if (typeof authorizeEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    return undefined
  }
  const registrationEndpoint = o.registration_endpoint
  const base = { authorizeEndpoint, tokenEndpoint } as const
  return typeof registrationEndpoint === "string" ? { ...base, registrationEndpoint } : base
}

const fetchAndParse = async (
  url: string,
  fetchPort: FetchPort,
): Promise<{ readonly status: number; readonly parsed: unknown | undefined }> => {
  const res = await fetchPort(url, { method: "GET" })
  if (!res.ok) return { status: res.status, parsed: undefined }
  const body = await res.text()
  try {
    return { status: res.status, parsed: JSON.parse(body) as unknown }
  } catch {
    throw new OAuthDiscoveryError(
      "well-known-malformed",
      `well-known document at ${url} is not valid JSON`,
    )
  }
}

export const discoverOAuthEndpoints = async (
  issuer: string,
  fetchPort: FetchPort,
): Promise<OAuthEndpoints> => {
  const base = normalizeIssuer(issuer)
  const wellKnownUrl = `${base}/.well-known/oauth-authorization-server`
  const oidcUrl = `${base}/.well-known/openid-configuration`

  let primaryResult: Awaited<ReturnType<typeof fetchAndParse>>
  try {
    primaryResult = await fetchAndParse(wellKnownUrl, fetchPort)
  } catch (e) {
    if (e instanceof OAuthDiscoveryError) throw e
    throw new OAuthDiscoveryError("network-failed", `network failed for ${wellKnownUrl}`, {
      cause: e,
    })
  }

  if (primaryResult.parsed !== undefined) {
    const endpoints = extractEndpoints(primaryResult.parsed)
    if (endpoints === undefined) {
      throw new OAuthDiscoveryError(
        "missing-required-field",
        "well-known document missing authorization_endpoint or token_endpoint",
      )
    }
    return endpoints
  }

  if (primaryResult.status !== 404) {
    throw new OAuthDiscoveryError(
      "well-known-404",
      `well-known endpoint returned status ${primaryResult.status}`,
    )
  }

  // RFC 8414 404 → fall back to OIDC discovery.
  let fallbackResult: Awaited<ReturnType<typeof fetchAndParse>>
  try {
    fallbackResult = await fetchAndParse(oidcUrl, fetchPort)
  } catch (e) {
    if (e instanceof OAuthDiscoveryError) throw e
    throw new OAuthDiscoveryError("network-failed", `network failed for ${oidcUrl}`, { cause: e })
  }

  if (fallbackResult.parsed === undefined) {
    throw new OAuthDiscoveryError(
      "well-known-404",
      `both RFC-8414 and OIDC discovery endpoints returned non-OK (last status ${fallbackResult.status})`,
    )
  }
  const endpoints = extractEndpoints(fallbackResult.parsed)
  if (endpoints === undefined) {
    throw new OAuthDiscoveryError(
      "missing-required-field",
      "OIDC discovery document missing authorization_endpoint or token_endpoint",
    )
  }
  return endpoints
}
