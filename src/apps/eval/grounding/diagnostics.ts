export const GROUNDING_ERROR_KINDS = [
  "auth",
  "billing",
  "rate_limit",
  "network",
  "provider_config",
  "non_json_response",
  "invalid_decision_shape",
  "unknown",
] as const

export type GroundingErrorKind = (typeof GROUNDING_ERROR_KINDS)[number]

const has = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase())

export const classifyGroundingInfraError = (message: string): GroundingErrorKind => {
  if (
    has(message, "401") ||
    has(message, "unauthorized") ||
    has(message, "token_invalidated") ||
    has(message, "authentication")
  ) {
    return "auth"
  }
  if (has(message, "credit balance is too low") || has(message, "billing")) {
    return "billing"
  }
  if (has(message, "429") || has(message, "rate limit") || has(message, "too many requests")) {
    return "rate_limit"
  }
  if (
    has(message, "api key not set") ||
    has(message, "api_key") ||
    has(message, "base url") ||
    has(message, "models lookup failed")
  ) {
    return "provider_config"
  }
  if (
    has(message, "econnreset") ||
    has(message, "etimedout") ||
    has(message, "network") ||
    has(message, "fetch failed") ||
    has(message, "socket")
  ) {
    return "network"
  }
  return "unknown"
}

export const classifyGroundingParserError = (message: string): GroundingErrorKind =>
  message === "no JSON object in response" ? "non_json_response" : "invalid_decision_shape"
