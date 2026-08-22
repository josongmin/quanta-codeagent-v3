/**
 * jun-6 exfil-rail (B) — secret-egress GATE (pure).
 *
 * WHAT: maps an INJECTED env bag to the resolved egress MODE (`deny`/`redact`)
 *       or `undefined` (OFF). The slice never reads `process.env` directly
 *       (memory rule: read injected env) so it is deterministic + unit-testable.
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.4
 * SLICES IMPORTED: `./secret-egress` (the mode type) only.
 * NO-THROW: total over the input record.
 *
 * DEFAULT-OFF: `QUANTA_SECRET_EGRESS` unset / any value other than the two exact
 * mode tokens ⇒ `undefined` ⇒ the proxy never injects a scanner, so the egress
 * decision stays HOST-ONLY (byte-identical). The RECOMMENDED mode is `redact`
 * (mask + forward) over `deny` for legit-but-leaky payloads (RFC §7 (B)).
 *
 * ⚠️ Even when ON this covers PLAINTEXT-HTTP egress only — the HTTPS CONNECT
 * tunnel is opaque (needs TLS MITM, a deferred Phase-2 RFC). The gate does NOT
 * claim HTTPS coverage.
 */

import type { SecretEgressMode } from "./secret-egress"

/** The env var name (QUANTA_<FEATURE> convention). */
export const SECRET_EGRESS_ENV = "QUANTA_SECRET_EGRESS"
/** Max-buffered-body byte cap (DoS guard). Positive integer; no default here —
 *  the wire resolves a named default (no magic literal in the gate). */
export const SECRET_EGRESS_MAX_BODY_ENV = "QUANTA_SECRET_EGRESS_MAX_BODY"

/**
 * Resolve the egress mode from an injected env bag. Returns `"deny"` or
 * `"redact"` for the exact tokens; every other shape (undefined, "", "1",
 * "true", arbitrary) ⇒ `undefined` (OFF). Never throws.
 */
export const secretEgressMode = (
  env: Readonly<Record<string, string | undefined>>,
): SecretEgressMode | undefined => {
  const v = env[SECRET_EGRESS_ENV]
  return v === "deny" || v === "redact" ? v : undefined
}
