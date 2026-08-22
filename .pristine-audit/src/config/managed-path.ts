/**
 * §P7 / ticket-05-③ — OS-managed-settings path enumeration (the machine layer).
 *
 * RCA of the gap: the `@/config` slice fully supports a `managed` layer (highest
 * precedence, non-overridable for `allowManaged*Only` keys), but the host wired
 * `managedPath: undefined`, so an org admin's machine-wide lockdown file was
 * NEVER read. This pure function supplies the conventional per-OS path so the
 * loader can read it (a non-existent file just contributes nothing — fail-safe).
 *
 * Pure: `(platform, override?) → path`. No `process`/env access — the host
 * passes the platform + the resolved `QUANTA_MANAGED_SETTINGS_PATH` override (via
 * `runtimeConfig`, so the knob is catalogued, not a raw env read here). Mirrors
 * the Claude Code / Cursor managed-settings convention per OS.
 */

/** The conventional machine-wide managed-settings file for `platform`. `override`
 *  (the resolved `QUANTA_MANAGED_SETTINGS_PATH`, when non-blank) wins on ALL
 *  platforms — the CI / test / non-standard-deploy escape hatch. Never returns
 *  `undefined`: an absent file is fail-safe (the loader's read yields `undefined`
 *  ⇒ no managed layer contribution), so there is no "no managed path on this OS"
 *  case to special-case. */
export const osManagedSettingsPath = (
  platform: NodeJS.Platform,
  override?: string,
  programData?: string,
): string => {
  const trimmed = override?.trim()
  if (trimmed !== undefined && trimmed !== "") return trimmed
  if (platform === "darwin") {
    return "/Library/Application Support/Quanta/managed-settings.json"
  }
  if (platform === "win32") {
    const base = programData?.trim() || "C:\\ProgramData"
    return `${base}\\Quanta\\managed-settings.json`
  }
  // linux + every other unix-like: the FHS machine-config location.
  return "/etc/quanta/managed-settings.json"
}
