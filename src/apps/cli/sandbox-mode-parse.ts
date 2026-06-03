/**
 * Hardened parser for the `SandboxMode` union.
 *
 * Pre-cleanup, the REPL did `env(…) as SandboxMode` — an unchecked TS cast.
 * A bogus value like `QUANTA_SANDBOX=badvalue` would propagate to the status
 * pill as a literal "badvalue" string, producing a silent UI lie. This helper
 * validates against the canonical union and falls back to `"default"` for
 * anything outside the allowed set (including empty / undefined).
 */

import { SANDBOX_MODES, type SandboxMode } from "./status-pills"

/** All valid {@link SandboxMode} values — built from the SSOT array
 *  {@link SANDBOX_MODES} (which the union itself derives from), so this set can
 *  NEVER drift from the union. Adding a variant in `status-pills` flows here
 *  automatically. */
export const VALID_SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set<SandboxMode>(SANDBOX_MODES)

/**
 * Parse a raw env value into a {@link SandboxMode}. Unknown / empty /
 * undefined ⇒ `"default"` (no silent UI lie).
 */
export const parseSandboxMode = (raw: string | undefined): SandboxMode => {
  if (raw === undefined || raw === "") return "default"
  return VALID_SANDBOX_MODES.has(raw as SandboxMode) ? (raw as SandboxMode) : "default"
}
