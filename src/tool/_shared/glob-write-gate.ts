/**
 * jun-6 exfil-rail (b) — glob-in-write guard GATE (pure).
 *
 * WHAT: maps an INJECTED env bag to the resolved boolean gate. The slice never
 *       reads `process.env` directly (memory rule: read injected env) so it is
 *       deterministic and unit-testable with a plain object.
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.2
 * SLICES IMPORTED: none (pure).
 * NO-THROW: total over the input record.
 *
 * DEFAULT-OFF: unset / any value other than the exact opt-in token ⇒ false.
 * The RFC argues this is a strong default-ON candidate after a soak (a glob in a
 * write target is virtually always a bug/attack), but it ships default-OFF for
 * byte-identity (mirrors `untrustedEnvelopeEnabled`).
 */

import { gateOnStrict } from "@/shared"

/** The env var name (QUANTA_<FEATURE> convention). */
export const GLOB_WRITE_GUARD_ENV = "QUANTA_GLOB_WRITE_GUARD"

/**
 * Resolve the gate from an injected env bag. `true` IFF
 * `env[QUANTA_GLOB_WRITE_GUARD] === "1"` (canonical strict gate via
 * `@/shared#gateOnStrict` — "0"/"true"/"on" do NOT enable it). Never throws.
 */
export const globWriteGuardEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  gateOnStrict(env, GLOB_WRITE_GUARD_ENV)
