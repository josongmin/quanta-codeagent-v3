/**
 * Deterministic application of a selected local environment onto a scrubbed
 * base env (ADR-0455).
 *
 * COMPOSITION WITH THE ALLOWLIST (the security rule):
 *   The declared env is added ON TOP of the already-scrubbed base — it does
 *   NOT bypass the allowlist. A declared var whose NAME is not in the active
 *   allowlist is DROPPED (it cannot smuggle a non-allowlisted name into the
 *   child). `PATH` is on `DEFAULT_ENV_ALLOWLIST`, so `pathPrepend` always
 *   applies; it is prepended to whatever `PATH` survived the scrub.
 *
 * BYTE-IDENTICAL DEFAULT-OFF:
 *   {@link applyLocalEnv} returns the SAME base env reference when there is no
 *   selection (or the selection is empty) — proven by tests. A composition
 *   root only threads a selection when a config file was actually loaded.
 *
 * NO HEURISTICS: every applied value comes from the parsed config. Nothing is
 * sniffed from the filesystem here.
 */

import type { LocalEnvConfig, LocalEnvSelection } from "./types"

/** The PATH key — declared `pathPrepend` fragments are prepended to whatever
 *  the scrubbed base carries for this name. Single source so apply + tests
 *  agree. */
const PATH_KEY = "PATH"

/** Resolve the selection to apply for a config, given an optional explicit
 *  env name. Returns `undefined` when nothing should apply (no name AND no
 *  default — default-OFF). Pure.
 *   - explicit `name` present  → that env (or `undefined` if it is not declared
 *                                — caller treats an unknown name as "no apply",
 *                                NOT a silent fallback to default);
 *   - no name, `defaultName` set → the default env;
 *   - neither                   → `undefined`. */
export const selectEnvironment = (
  config: LocalEnvConfig,
  name?: string,
): LocalEnvSelection | undefined => {
  if (name !== undefined) {
    const env = config.environments[name]
    return env === undefined ? undefined : { vars: env.vars, pathPrepend: env.pathPrepend }
  }
  if (config.defaultName !== undefined) {
    const env = config.environments[config.defaultName]
    return env === undefined ? undefined : { vars: env.vars, pathPrepend: env.pathPrepend }
  }
  return undefined
}

/** True when a selection would mutate the env at all. Used to short-circuit to
 *  the byte-identical same-reference return. */
const isEmptySelection = (s: LocalEnvSelection): boolean =>
  Object.keys(s.vars).length === 0 && s.pathPrepend.length === 0

/**
 * Compose a selected environment onto a scrubbed base env, GOVERNED BY the
 * allowlist. Never mutates `base`; allocates a fresh object only on the apply
 * path. Returns the SAME `base` reference when `selection` is absent or empty
 * (byte-identical default-OFF).
 *
 * @param base       the already-scrubbed child env (only allowlisted names).
 * @param selection  the declared env to overlay, or `undefined` (no-op).
 * @param allowlist  the SAME allowlist used to scrub `base`. A declared var
 *                   whose name is not here is DROPPED. PATH is expected to be
 *                   on the allowlist for `pathPrepend` to take effect.
 */
export const applyLocalEnv = (
  base: NodeJS.ProcessEnv,
  selection: LocalEnvSelection | undefined,
  allowlist: readonly string[],
): NodeJS.ProcessEnv => {
  if (selection === undefined || isEmptySelection(selection)) return base // same reference

  const allowed = new Set(allowlist)
  const out: NodeJS.ProcessEnv = { ...base }

  // 1) Var overlays — only allowlisted names pass. A declared var NOT on the
  //    allowlist is dropped (the allowlist still governs what reaches the child).
  for (const [k, v] of Object.entries(selection.vars)) {
    if (allowed.has(k)) out[k] = v
  }

  // 2) PATH prepend — only when PATH is allowlisted (it is, by default). The
  //    fragments are joined with the platform path delimiter and placed BEFORE
  //    the surviving PATH so the declared env's binaries win. Order preserved:
  //    the first fragment ends up first.
  if (selection.pathPrepend.length > 0 && allowed.has(PATH_KEY)) {
    const sep = pathDelimiter()
    const prefix = selection.pathPrepend.join(sep)
    const existing = out[PATH_KEY]
    out[PATH_KEY] =
      existing !== undefined && existing.length > 0 ? `${prefix}${sep}${existing}` : prefix
  }

  return out
}

/** Platform PATH delimiter. `:` on POSIX, `;` on Windows. Isolated so apply +
 *  tests reference one definition (no Date/random — `process.platform` is a
 *  stable build-time fact, not a heuristic). */
const pathDelimiter = (): string => (process.platform === "win32" ? ";" : ":")
