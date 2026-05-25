/**
 * Headless-stub attestor (ADR-0246).
 *
 * Fail-closed posture for CI / batch / headless modes that have no real
 * bridge wired:
 *
 *   - `preflight` → `{ kind: "deny", reason: "headless: no remote attestor" }`
 *   - `mintToken` → throws `AttestError("headless")`
 *   - `verify`    → always false (no tokens were ever minted via this stub)
 *   - `revoke`    → no-op (idempotent / nothing to revoke)
 *
 * Lets composition roots load the `@/security/bridge-attest` barrel without a
 * real attestor configured, while guaranteeing every preflight is a `deny`
 * (never accidentally `allow`).
 */
import type { BridgeAttestor } from "./port"
import { AttestError, type AttestRequest, type AttestResult, type StsToken } from "./types"

const HEADLESS_REASON = "headless: no remote attestor"

/**
 * Build a headless attestor instance. Pure / stateless — safe to call once
 * at composition-root time and share across consumers.
 */
export const headlessStubAttestor = (): BridgeAttestor => ({
  async preflight(_req: AttestRequest): Promise<AttestResult> {
    return { kind: "deny", reason: HEADLESS_REASON }
  },
  async mintToken(_scope: string, _ttlMs: number): Promise<StsToken> {
    throw new AttestError(HEADLESS_REASON, "headless")
  },
  async verify(_token: string, _scope: string): Promise<boolean> {
    return false
  },
  async revoke(_token: string): Promise<void> {
    // no-op
  },
})
