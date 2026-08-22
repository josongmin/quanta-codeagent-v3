/**
 * `@/shared/quanta-home` — the SINGLE resolver for Quanta's on-disk home dir.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two roots were absorbed from different competitors and never reconciled:
 *   - `QUANTA_CONFIG_DIR` — the Claude `CLAUDE_CONFIG_DIR` analogue (config root),
 *   - `QUANTA_HOME`       — the Codex app-home convention (state root).
 * Both default to `~/.quanta`. The result was a SPLIT-BRAIN: `@/config` + trust
 * honored CONFIG_DIR, permission-state + bench honored HOME, and ~a dozen other
 * subsystems (sticky-model, scheduler, oauth creds, caches, sessions, …)
 * hard-coded `join(homedir(), ".quanta")` and honored NEITHER. A user who set
 * either override got a half-moved home.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * ONE canonical root. `QUANTA_CONFIG_DIR` wins (it is the documented Claude
 * analogue); `QUANTA_HOME` is kept as a backward-compatible fallback alias; both
 * unset ⇒ `~/.quanta`. Every default-path site derives from {@link quantaHomeDir}
 * (a subsystem keeps its OWN more-specific override — e.g. `QUANTA_SESSIONS_DIR`
 * — as the highest precedence, falling back to `join(quantaHomeDir(), "sub")`).
 *
 * BACKWARD-COMPAT: with neither override set the value is exactly
 * `join(homedir(), ".quanta")` — byte-identical to every legacy hard-code, so
 * the 99% default path does not move. Only a user who explicitly set a custom
 * root sees their previously-split state consolidate (a one-time re-home — the
 * fix working as intended).
 *
 * Reads via {@link runtimeConfig} (which resolves the env knobs through the
 * precedence chain), so this adds ZERO new raw `process.env` reads.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { runtimeConfig } from "./runtime-config"

/** The default home when no override is set. */
const defaultHome = (): string => join(homedir(), ".quanta")

/** Apply the unified precedence to an already-resolved (config, home) pair. A
 *  blank string (`""`) counts as unset — matches the env/runtime-config
 *  treatment of an empty override. */
const pickRoot = (configDir: string | undefined, home: string | undefined): string => {
  if (configDir !== undefined && configDir.length > 0) return configDir
  if (home !== undefined && home.length > 0) return home
  return defaultHome()
}

/**
 * Resolve Quanta's home directory: `QUANTA_CONFIG_DIR ?? QUANTA_HOME ??
 * ~/.quanta`. Safe to call at any time (including module-load) — `runtimeConfig`
 * self-initializes from `process.env`.
 */
export const quantaHomeDir = (): string => {
  const rc = runtimeConfig()
  return pickRoot(rc.centralConfigDir, rc.quantaHome)
}

/**
 * The DI-env twin of {@link quantaHomeDir}: resolve the unified home root from
 * an INJECTED env bag (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`), same
 * precedence as the singleton. For composition-root sites that already hold a
 * (possibly test-injected) `env` and must NOT reach the global runtimeConfig.
 */
export const quantaHomeDirFrom = (env: Record<string, string | undefined>): string =>
  pickRoot(env.QUANTA_CONFIG_DIR, env.QUANTA_HOME)

/** Convenience: a path under the Quanta home dir (`quantaHomeDir()/<segments>`). */
export const quantaHomePath = (...segments: string[]): string => join(quantaHomeDir(), ...segments)
