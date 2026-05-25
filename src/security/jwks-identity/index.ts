/**
 * JWKS agent identity barrel (ADR-0248). Public surface for callers
 * (agent-task registrar, realtime auth, scheduler webhook). Nothing in
 * the dispatch / loop seam imports this today — default-OFF until a caller
 * opts in.
 */

export { type DefaultJwksClientOpts, defaultJwksClient } from "./default-client"
export { headlessJwksClient } from "./headless-stub"
export type { JwksClient } from "./port"
export {
  type JsonWebKey,
  JwksError,
  JwksFetchError,
  type JwksSet,
  JwksVerifyError,
  type VerifyFailureReason,
  type VerifyResult,
} from "./types"
