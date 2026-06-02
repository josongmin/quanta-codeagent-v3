/**
 * Pure, total, fail-closed parser for the local-environment config (ADR-0455).
 *
 * Schema (TOML, `.quanta/environment.toml`):
 *
 *   default = "py"            # optional; must name a declared env
 *
 *   [env.py]
 *   vars = { PYTHONPATH = "src", VIRTUAL_ENV = ".venv" }
 *   pathPrepend = [".venv/bin"]
 *
 *   [env.node20]
 *   vars = { NODE_ENV = "development" }
 *   pathPrepend = ["node_modules/.bin"]
 *
 * EVERY value comes from the parsed config — there is NO filesystem sniffing,
 * NO "detect a venv by looking for a dir" heuristic. A malformed config yields
 * a typed {@link LocalEnvParseResult} with a CLOSED reason; the parser NEVER
 * returns a silent default / partial config.
 */

import type {
  DeclaredEnvironment,
  LocalEnvConfig,
  LocalEnvParseErrorReason,
  LocalEnvParseResult,
  TomlParse,
} from "./types"

/** Legal POSIX-ish env-var name: letter/underscore start, then alnum/underscore.
 *  Rejects names with `=`, NUL, spaces, or shell metacharacters so a declared
 *  var cannot smuggle a second assignment or break the env table. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type ParseFailure = {
  readonly ok: false
  readonly reason: LocalEnvParseErrorReason
  readonly detail: string
}

const fail = (reason: LocalEnvParseErrorReason, detail: string): ParseFailure => ({
  ok: false,
  reason,
  detail,
})

/** Discriminate a typed failure from a success payload. Checks the literal
 *  `ok:false` shape — NOT just an `"ok" in x` key probe, since a validated
 *  config could legitimately declare a var/env literally named `ok`. */
const isFailure = (x: unknown): x is ParseFailure =>
  typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Validate a single `pathPrepend` entry. Rejects anything that could inject a
 *  SECOND path element (`:`), a var assignment (`=`), or a NUL — so a declared
 *  fragment is exactly one directory segment, never an arbitrary PATH override.
 *  Empty / whitespace-only entries are rejected (a no-op fragment is a config
 *  bug, fail closed). */
const isValidPathEntry = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.trim().length > 0 &&
  !s.includes(":") &&
  !s.includes("=") &&
  !s.includes("\0")

/** Validate the `vars` sub-table. Returns the normalized map OR a typed error
 *  on the first violation (fail closed). */
const parseVars = (name: string, rawVars: unknown): Record<string, string> | ParseFailure => {
  if (rawVars === undefined) return {}
  if (!isPlainObject(rawVars)) {
    return fail("bad_env_table", `[env.${name}].vars is not a table`)
  }
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawVars)) {
    if (!ENV_NAME_RE.test(k)) {
      return fail("bad_var_name", `[env.${name}].vars: illegal env-var name "${k}"`)
    }
    if (typeof v !== "string" || v.includes("\0")) {
      return fail("bad_var_value", `[env.${name}].vars.${k} must be a string without NUL`)
    }
    vars[k] = v
  }
  return vars
}

/** Validate the `pathPrepend` array. Returns the normalized list OR a typed
 *  error on the first violation (fail closed). */
const parsePathPrepend = (name: string, rawPath: unknown): string[] | ParseFailure => {
  if (rawPath === undefined) return []
  if (!Array.isArray(rawPath)) {
    return fail("bad_path_entry", `[env.${name}].pathPrepend must be an array`)
  }
  const out: string[] = []
  for (const entry of rawPath) {
    if (!isValidPathEntry(entry)) {
      return fail(
        "bad_path_entry",
        `[env.${name}].pathPrepend entries must be single non-empty path fragments (no ":", "=", NUL)`,
      )
    }
    out.push(entry)
  }
  return out
}

/** Validate + normalize one `[env.<name>]` table into a {@link DeclaredEnvironment}.
 *  Returns a typed error result on the FIRST violation (fail closed). */
const parseEnvTable = (name: string, raw: unknown): DeclaredEnvironment | ParseFailure => {
  if (!isPlainObject(raw)) {
    return fail("bad_env_table", `[env.${name}] is not a table`)
  }
  const vars = parseVars(name, raw.vars)
  if (isFailure(vars)) return vars
  const pathPrepend = parsePathPrepend(name, raw.pathPrepend)
  if (isFailure(pathPrepend)) return pathPrepend
  return { name, vars, pathPrepend }
}

/** Parse + validate a local-env config body. Pure + total: never throws (a
 *  TOML syntax error from the injected `toml` parser is caught and mapped to a
 *  `toml_syntax` result). Fail-closed on every malformed shape. */
export const parseLocalEnvConfig = (body: string, toml: TomlParse): LocalEnvParseResult => {
  let parsed: unknown
  try {
    parsed = toml(body)
  } catch (err) {
    return fail("toml_syntax", err instanceof Error ? err.message : String(err))
  }

  if (!isPlainObject(parsed)) {
    return fail("not_a_table", "top-level config is not a table")
  }

  const rawEnvs = parsed.env
  if (!isPlainObject(rawEnvs) || Object.keys(rawEnvs).length === 0) {
    return fail("no_environments", "no [env.<name>] tables declared")
  }

  const environments: Record<string, DeclaredEnvironment> = {}
  for (const [name, rawTable] of Object.entries(rawEnvs)) {
    const result = parseEnvTable(name, rawTable)
    if (isFailure(result)) return result // typed error short-circuits
    environments[name] = result
  }

  let defaultName: string | undefined
  const rawDefault = parsed.default
  if (rawDefault !== undefined) {
    if (typeof rawDefault !== "string") {
      return fail("bad_default", "`default` must be a string naming a declared env")
    }
    if (environments[rawDefault] === undefined) {
      return fail("default_unknown", `default "${rawDefault}" is not a declared env`)
    }
    defaultName = rawDefault
  }

  const config: LocalEnvConfig =
    defaultName !== undefined ? { environments, defaultName } : { environments }
  return { ok: true, config }
}
