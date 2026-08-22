/**
 * untrusted-source-envelope — gate resolution (ADR-0471).
 *
 * WHAT: maps an INJECTED env bag to the resolved boolean gate. The slice never
 *       reads `process.env` directly (memory rule: read injected env) so it is
 *       deterministic and unit-testable with a plain object.
 * ADR: 0471 (untrusted-source-envelope)
 * SLICES IMPORTED: none (pure).
 * NO-THROW: total over the input record.
 *
 * DEFAULT-OFF: unset / any value other than the exact opt-in token ⇒ false.
 */

import { gateOnStrict } from "@/shared"

/** The env var name. Mirrors the project convention (QUANTA_<FEATURE>). */
export const UNTRUSTED_ENVELOPE_ENV = "QUANTA_UNTRUSTED_ENVELOPE"

/**
 * Resolve the gate from an injected env bag. `true` IFF
 * `env[QUANTA_UNTRUSTED_ENVELOPE] === "1"` (canonical strict gate via
 * `@/shared#gateOnStrict` — "0"/"false"/"on"/"true" do NOT enable it). Never throws.
 */
export const untrustedEnvelopeEnabled = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => gateOnStrict(env, UNTRUSTED_ENVELOPE_ENV)
