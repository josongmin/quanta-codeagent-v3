/**
 * jun-6 exfil-rail (c) — exfil-scouting GATE (pure).
 *
 * WHAT: maps an INJECTED env bag to the resolved boolean gate. The slice never
 *       reads `process.env` directly (memory rule: read injected env) so it is
 *       deterministic and unit-testable with a plain object.
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.3
 * SLICES IMPORTED: none (pure).
 * NO-THROW: total over the input record.
 *
 * DEFAULT-OFF: unset / any value other than the exact opt-in token ⇒ false.
 * When OFF the deterministic `detectScouting` aggregate is never called and the
 * "Exfil Scouting" taxonomy prose line is omitted from the assembled classifier
 * prompt (byte-identical prompt + behavior). The signal is ADVISORY when ON
 * (a classification hint, never a hard auto-deny) — see RFC §7 (c).
 */

/** The env var name (QUANTA_<FEATURE> convention). */
export const EXFIL_SCOUTING_ENV = "QUANTA_EXFIL_SCOUTING"

/** The EXACT opt-in token — strict equality (mirrors the other strict gates). */
const OPT_IN_TOKEN = "1"

/**
 * Resolve the gate from an injected env bag. `true` IFF
 * `env[QUANTA_EXFIL_SCOUTING] === "1"`. Every other shape (undefined, "", "0",
 * "true", arbitrary) ⇒ `false` (OFF). Never throws.
 */
export const exfilScoutingEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[EXFIL_SCOUTING_ENV] === OPT_IN_TOKEN
