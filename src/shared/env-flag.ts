/**
 * Pure env-flag truth table shared by every surface that wants a capability
 * default-ON but still env-disablable. Mirrors the CLI status-pill `envFlag`
 * semantics so CLI and web-daemon flip the same way:
 *   - unset                  → `defaultOn`
 *   - "" / 1 / true/on/yes    → true
 *   - 0 / false/off/no        → false
 *   - anything else          → `defaultOn`
 *
 * Pure: it does NOT read `process.env` itself — the surface owns the read and
 * passes the raw value in — so it is safe in the env-read-free `assemble`
 * layer AND in any leaf library slice. Lives in `@/shared` (a true leaf) so
 * that library slices (`@/memory`) and Layer-1 (`@/agent`) can consume it
 * WITHOUT a layering inversion into the Layer-2 `@/runner` composition slice.
 */
export const parseEnvFlag = (raw: string | undefined, defaultOn: boolean): boolean => {
  if (raw === undefined) return defaultOn
  const v = raw.trim().toLowerCase()
  if (v === "" || v === "1" || v === "true" || v === "on" || v === "yes") return true
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  return defaultOn
}
