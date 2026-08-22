/**
 * OAuth dynamic client registration (ADR-0160 Phase C).
 *
 * Implements RFC 7591 §3.1 — POST `client_metadata` to the registration
 * endpoint, parse the typed response. Throws `OAuthRegistrationError` with a
 * stable `code` arm on failure.
 *
 * Minimal happy-path fields are enforced (`client_id`); secret + access
 * token are optional per RFC 7591 §3.2.1.
 */

import { type FetchPort, OAuthRegistrationError } from "./types"

export interface OAuthClientMetadata {
  readonly redirectUris: ReadonlyArray<string>
  readonly clientName?: string
  readonly tokenEndpointAuthMethod?: string
  readonly grantTypes?: ReadonlyArray<string>
  readonly responseTypes?: ReadonlyArray<string>
  readonly scope?: string
}

export interface OAuthClientRegistration {
  readonly clientId: string
  readonly clientSecret?: string
  readonly registrationAccessToken?: string
  readonly registrationClientUri?: string
}

const toRequestBody = (metadata: OAuthClientMetadata): string => {
  const body: Record<string, unknown> = {
    redirect_uris: metadata.redirectUris,
  }
  if (metadata.clientName !== undefined) body.client_name = metadata.clientName
  if (metadata.tokenEndpointAuthMethod !== undefined) {
    body.token_endpoint_auth_method = metadata.tokenEndpointAuthMethod
  }
  if (metadata.grantTypes !== undefined) body.grant_types = metadata.grantTypes
  if (metadata.responseTypes !== undefined) body.response_types = metadata.responseTypes
  if (metadata.scope !== undefined) body.scope = metadata.scope
  return JSON.stringify(body)
}

const extractRegistration = (doc: unknown): OAuthClientRegistration => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new OAuthRegistrationError(
      "registration-malformed",
      "registration response is not a JSON object",
    )
  }
  const o = doc as Record<string, unknown>
  const clientId = o.client_id
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new OAuthRegistrationError("missing-client-id", "registration response missing client_id")
  }
  return {
    clientId,
    ...(typeof o.client_secret === "string" ? { clientSecret: o.client_secret } : {}),
    ...(typeof o.registration_access_token === "string"
      ? { registrationAccessToken: o.registration_access_token }
      : {}),
    ...(typeof o.registration_client_uri === "string"
      ? { registrationClientUri: o.registration_client_uri }
      : {}),
  }
}

export const registerOAuthClient = async (
  registrationEndpoint: string,
  metadata: OAuthClientMetadata,
  fetchPort: FetchPort,
): Promise<OAuthClientRegistration> => {
  let res: Awaited<ReturnType<FetchPort>>
  try {
    res = await fetchPort(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: toRequestBody(metadata),
    })
  } catch (e) {
    throw new OAuthRegistrationError(
      "network-failed",
      `network failed for ${registrationEndpoint}`,
      { cause: e },
    )
  }

  if (!res.ok) {
    throw new OAuthRegistrationError(
      "registration-rejected",
      `registration endpoint returned status ${res.status}`,
    )
  }

  const body = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    throw new OAuthRegistrationError(
      "registration-malformed",
      "registration response is not valid JSON",
      { cause: e },
    )
  }
  return extractRegistration(parsed)
}
