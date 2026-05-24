/**
 * Hardened parser for the `SandboxMode` union.
 *
 * Pre-cleanup, the REPL did `env(…) as SandboxMode` — an unchecked TS cast.
 * A bogus value like `QUANTA_SANDBOX=badvalue` would propagate to the status
 * pill as a literal "badvalue" string, producing a silent UI lie. This helper
 * validates against the canonical union and falls back to `"default"` for
 * anything outside the allowed set (including empty / undefined).
 */

import type { SandboxMode } from "./status-pills"

/** All valid {@link SandboxMode} values — copy of the union in `status-pills`.
 *  Kept in sync via the {@link parseSandboxMode} fallback path: a new variant
 *  must be added HERE before it'll round-trip cleanly. */
export const VALID_SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set<SandboxMode>([
  "read-only",
  "workspace",
  "danger",
  "default",
])

/**
 * Parse a raw env value into a {@link SandboxMode}. Unknown / empty /
 * undefined ⇒ `"default"` (no silent UI lie).
 */
export const parseSandboxMode = (raw: string | undefined): SandboxMode => {
  if (raw === undefined || raw === "") return "default"
  return VALID_SANDBOX_MODES.has(raw as SandboxMode) ? (raw as SandboxMode) : "default"
}
