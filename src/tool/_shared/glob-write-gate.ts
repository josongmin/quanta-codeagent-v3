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

/** The env var name (QUANTA_<FEATURE> convention). */
export const GLOB_WRITE_GUARD_ENV = "QUANTA_GLOB_WRITE_GUARD"

/** The EXACT opt-in token — strict equality (mirrors the other strict gates). */
const OPT_IN_TOKEN = "1"

/**
 * Resolve the gate from an injected env bag. `true` IFF
 * `env[QUANTA_GLOB_WRITE_GUARD] === "1"`. Every other shape (undefined, "",
 * "0", "true", arbitrary) ⇒ `false` (OFF). Never throws.
 */
export const globWriteGuardEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[GLOB_WRITE_GUARD_ENV] === OPT_IN_TOKEN
