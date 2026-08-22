/**
 * Bridge-attestation closed types (ADR-0246).
 *
 * Closed `AttestRequest` / `AttestResult` / `StsToken` / `AttestError` shapes
 * + 9-event lifecycle union for the remote permission preflight + STS token
 * surface absorbed from Claude Desktop `onBridgePermissionPreflight`.
 *
 * Plane discipline: zero quanta imports — this file is pure types, safely
 * loaded in a Tauri sidecar, worker thread, or standalone attestation binary.
 *
 * Default-OFF: nothing in dispatch/loop/agent references these types today.
 * The caller (a future MCP tool, a Tauri bridge wrapper) opts in.
 */

/**
 * One preflight request. Caller (a remote-tool dispatcher about to invoke a
 * mutating action) supplies an opaque `agentId`, an `action` discriminator
 * (caller convention: e.g. `"tool.exec"`, `"connector.write"`), and a
 * `resource` string the policy table can match. `requestedAt` is checked by
 * the default adapter against its bounded freshness/skew policy before any
 * allow token can be issued.
 */
export interface AttestRequest {
  readonly agentId: string
  readonly action: string
  readonly resource: string
  readonly requestedAt: number
}

/** Canonical, collision-free token scope for one preflight request. Consumers
 * reconstruct this exact value from their expected request before `verify`;
 * the agent identity is part of the scope so a token cannot cross agents. */
export const attestationScopeFor = (req: AttestRequest): string =>
  JSON.stringify([req.agentId, req.action, req.resource])

/**
 * Short-lived STS token issued on `allow`. `token` is the base64url-encoded
 * HMAC-SHA256 envelope `secret | scope | expiresAt | nonce`. `scope` MUST
 * match on the consuming `verify` call. `expiresAt` is absolute epoch-ms.
 */
export interface StsToken {
  readonly token: string
  readonly expiresAt: number
  readonly scope: string
}

/**
 * 3-arm discriminated result of `preflight`. Closed union — adding a 4th arm
 * without exhaustive-switch wiring is a TS error at compile time (the
 * hellgate suite asserts this).
 *
 * `allow` carries the freshly-minted `stsToken` the caller MUST present to
 *   downstream `verify`.
 * `deny` carries a non-empty `reason` string — never empty so audit logs
 *   always have a payload.
 * `prompt-user` defers to a host-side gesture (CLI confirm / Tauri dialog).
 *   `reason` is optional context for the prompt.
 *
 * Note: exactOptionalPropertyTypes is ON so `reason` is genuinely omittable
 *       on `prompt-user`; explicit `undefined` is rejected by the type
 *       checker — pass `{ kind: "prompt-user" }` not `{ ..., reason: undefined }`.
 */
export type AttestResult =
  | { readonly kind: "allow"; readonly stsToken: StsToken }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "prompt-user"; readonly reason?: string }

/**
 * Typed error for constructor/configuration failures. `preflight` itself is
 * NO-THROW by contract; an internal failure surfaces as `{ kind: "deny",
 * reason }` + a `preflight-error` audit event.
 */
export class AttestError extends Error {
  constructor(
    message: string,
    public readonly code: "tampered" | "expired" | "scope-mismatch" | "misconfigured" | "internal",
  ) {
    super(message)
    this.name = "AttestError"
  }
}

/**
 * 9-event lifecycle union. Each event carries `{ requestId, at }` minimum so
 * an audit sink can stitch the full preflight → mint → use → expire → revoke
 * timeline. `attest-audit` is the catch-all envelope a jsonl-recorder or
 * OTel sink subscribes to for one stream per attestation lifecycle.
 *
 * Closed enum — adding a 10th kind without wiring is a TS error in any
 * consumer that switch-exhausts over `AttestEvent["kind"]`.
 */
export type AttestEvent =
  | {
      readonly kind: "preflight-requested"
      readonly requestId: string
      readonly at: number
      readonly action: string
    }
  | {
      readonly kind: "preflight-granted"
      readonly requestId: string
      readonly at: number
      readonly scope: string
    }
  | {
      readonly kind: "preflight-denied"
      readonly requestId: string
      readonly at: number
      readonly reason: string
    }
  | {
      readonly kind: "token-minted"
      readonly requestId: string
      readonly at: number
      readonly scope: string
      readonly expiresAt: number
    }
  | {
      readonly kind: "token-used"
      readonly requestId: string
      readonly at: number
      readonly scope: string
    }
  | {
      readonly kind: "token-expired"
      readonly requestId: string
      readonly at: number
      readonly scope: string
    }
  | {
      readonly kind: "token-revoked"
      readonly requestId: string
      readonly at: number
      readonly scope: string
    }
  | {
      readonly kind: "preflight-error"
      readonly requestId: string
      readonly at: number
      readonly error: string
    }
  | {
      readonly kind: "attest-audit"
      readonly requestId: string
      readonly at: number
      readonly summary: string
    }

/**
 * Subscriber callback. Default = no-op (default-OFF — slice is silent until
 * a caller opts in by passing `onEvent`).
 */
export type AttestEventSink = (event: AttestEvent) => void

/**
 * Closed verdict for the policy-table lookup. Mirrors the 3-arm result kinds
 * but is the INPUT shape (action → verdict). The default-attestor maps
 * `"prompt-user"` straight through, mints a token on `"allow"`, and turns
 * `"deny"` into a `{kind:"deny", reason}` with the table-supplied reason.
 */
export type PolicyVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "prompt-user"; readonly reason?: string }

/**
 * Policy table — action discriminator → verdict. Default empty (every action
 * → `prompt-user` with no reason). Caller-supplied via constructor opt.
 */
export type PolicyTable = Readonly<Record<string, PolicyVerdict>>
