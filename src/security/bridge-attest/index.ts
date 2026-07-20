/**
 * Bridge-attestation barrel (ADR-0246). Public surface for callers (a future
 * MCP `bridge_attest_preflight` tool, a Tauri sidecar bridge wrapper, an
 * org-policy proxy). Default-OFF — nothing in dispatch / loop / agent imports
 * this today.
 *
 * Adapter choice:
 *   - {@link defaultAttestor} — production-grade in-process HMAC-SHA256 +
 *     policy-table; the only non-stub option today.
 *   - {@link headlessStubAttestor} — fail-closed deny-all for CI / batch.
 */
export {
  type DefaultAttestorOpts,
  defaultAttestor,
} from "./default-attestor"
export { headlessStubAttestor } from "./headless-stub"
export type { BridgeAttestor } from "./port"
export {
  AttestError,
  type AttestEvent,
  type AttestEventSink,
  type AttestRequest,
  type AttestResult,
  attestationScopeFor,
  type PolicyTable,
  type PolicyVerdict,
  type StsToken,
} from "./types"
