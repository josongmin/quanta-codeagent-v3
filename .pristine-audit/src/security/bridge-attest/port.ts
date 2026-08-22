/**
 * BridgeAttestor port (ADR-0246).
 *
 * Hexagonal seam for "remote permission preflight + STS token" — absorbs
 * Claude Desktop's `onBridgePermissionPreflight` round-trip surface into a
 * 3-method port. Two adapters implement this port:
 *
 *   - {@link defaultAttestor} — in-process policy-table + HMAC-SHA256 secret
 *     (Node `node:crypto`); the production-grade leaf for self-hosted bridges
 *     and unit tests.
 *   - {@link headlessStubAttestor} — deny-all `preflight` and never verifies
 *     a token; the fail-closed posture for CI / batch / headless modes that
 *     have no real bridge wired.
 *
 * Default-OFF: nothing in dispatch / loop / agent wires this today. The caller
 * (a future MCP `bridge_attest_preflight` tool, a Tauri sidecar wrapper, an
 * org-policy proxy) opts in by constructing the adapter.
 *
 * Plane discipline: imports types only from this slice; never crosses into
 * `@/agent`, `@/permission`, `@/observability`.
 */
import type { AttestRequest, AttestResult } from "./types"

/**
 * Port surface. 3 methods, all `Promise`-returning so a future remote
 * adapter (gRPC, WebSocket, Tauri IPC) drops in without breaking callers.
 *
 *   - `preflight` — NO-THROW contract. Internal failures surface as
 *     `{ kind: "deny", reason }` + a `preflight-error` audit event.
 *   - STS issuance is intentionally NOT a public operation. `preflight` is
 *     the sole capability that can mint an allow-token, so callers cannot
 *     bypass the action policy by choosing an arbitrary scope or TTL.
 *   - `verify` — pure check (signature + expiry + scope match). Returns
 *     `false` for any failure; never throws.
 *   - `revoke` — marks a token revoked; subsequent `verify` calls return
 *     false. Idempotent — revoking an unknown / already-revoked token is a
 *     silent success.
 */
export interface BridgeAttestor {
  preflight(req: AttestRequest): Promise<AttestResult>
  verify(token: string, scope: string): Promise<boolean>
  revoke(token: string): Promise<void>
}
