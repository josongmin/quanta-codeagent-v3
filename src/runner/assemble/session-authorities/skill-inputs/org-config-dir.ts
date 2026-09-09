/**
 * Org-config directory resolution (G-F11).
 *
 * `undefined` / omitted explicit = default (`QUANTA_ORG_CONFIG_DIR` then
 * platform XDG/APPDATA path). Explicit `null` or empty env override = opt-out
 * (no admin policy / admin-skills scan). Surfaces resolve once and pass the
 * result into `snapshotInputs.orgConfigDir`.
 */
import { homedir } from "node:os"
import { join } from "node:path"

const ENV_KEY = "QUANTA_ORG_CONFIG_DIR"

const nonempty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined

/** Platform default from ADR-0134: `~/.config/quanta/org` or `%APPDATA%\quanta\org`. */
export const defaultOrgConfigDir = (
  env: Record<string, string | undefined>,
  home = homedir(),
): string => {
  if (process.platform === "win32") {
    const appdata = nonempty(env.APPDATA) ?? join(home, "AppData", "Roaming")
    return join(appdata, "quanta", "org")
  }
  const xdg = nonempty(env.XDG_CONFIG_HOME) ?? join(home, ".config")
  return join(xdg, "quanta", "org")
}

/**
 * Resolve the org config directory for skill snapshot + admin policy.
 *
 * @param explicit — `null` opt-out; nonempty string wins; omit for default.
 */
export const resolveOrgConfigDir = (
  env: Record<string, string | undefined>,
  explicit?: string | null,
): string | null => {
  if (explicit === null) return null
  const fromExplicit = nonempty(explicit ?? undefined)
  if (fromExplicit !== undefined) return fromExplicit
  const fromEnv = env[ENV_KEY]
  if (fromEnv !== undefined && fromEnv.trim() === "") return null
  const envDir = nonempty(fromEnv)
  if (envDir !== undefined) return envDir
  return defaultOrgConfigDir(env)
}
