/**
 * Closed types for the agent-driven local-environment slice (ADR-0455).
 *
 * A project DECLARES one or more named dev environments in a config file
 * (`.quanta/environment.toml`); the agent SELECTS one and the spawned shell
 * tools get its declared vars / PATH-prepends applied ON TOP of the scrubbed,
 * allowlisted base env. There is NO heuristic env detection — nothing is
 * sniffed from the filesystem; every value comes from the parsed config.
 *
 * Default-OFF: with no config file the agent inherits the ambient (scrubbed)
 * env exactly as before — see `applyLocalEnv` for the byte-identical guarantee.
 */

/** A single DECLARED environment, fully validated.
 *
 *  `vars` are concrete `NAME=value` pairs to OVERLAY on the base env.
 *  `pathPrepend` are directory fragments prepended to `PATH` (in order: the
 *  first entry ends up FIRST on the resulting PATH). Both are deterministic;
 *  neither is an exec hook — the "activate" semantics of a venv are expressed
 *  purely as env mutations (e.g. prepend `.venv/bin`, set `VIRTUAL_ENV`). */
export interface DeclaredEnvironment {
  /** Stable name the agent references when switching (`[env.<name>]`). */
  readonly name: string
  /** Concrete env-var overlays. Keys validated as legal env-var names. */
  readonly vars: Readonly<Record<string, string>>
  /** Path fragments to prepend to `PATH`, in declaration order. Validated:
   *  non-empty, no `:` (single fragment only), no `=`, no NUL. */
  readonly pathPrepend: readonly string[]
}

/** The full parsed + validated config. `default` (when present) names the
 *  environment selected when the agent does not pick one explicitly. */
export interface LocalEnvConfig {
  /** All declared environments, keyed by name (insertion order not relied on). */
  readonly environments: Readonly<Record<string, DeclaredEnvironment>>
  /** Optional default selection. When set it MUST name a declared env (the
   *  parser fails closed otherwise). Absent ⇒ no implicit selection. */
  readonly defaultName?: string
}

/** CLOSED reason enum for a config that cannot be trusted. The parser is
 *  fail-closed: ANY malformed input yields a typed error, NEVER a silent
 *  default / partial config. Adding a reason is a compile-error at every
 *  exhaustive switch. */
export type LocalEnvParseErrorReason =
  | "toml_syntax" // the TOML body did not parse
  | "not_a_table" // top-level value is not an object/table
  | "no_environments" // `[env]` missing or empty
  | "bad_env_table" // `[env.<name>]` is not a table
  | "bad_var_name" // a var key is not a legal env-var name
  | "bad_var_value" // a var value is not a string
  | "bad_path_entry" // a pathPrepend entry failed validation
  | "default_unknown" // `default` names an env that was not declared
  | "bad_default" // `default` is present but not a string

/** Typed, total parse outcome. `ok:false` carries a CLOSED reason + an opaque
 *  human-readable detail (never echoed into a child env). */
export type LocalEnvParseResult =
  | { readonly ok: true; readonly config: LocalEnvConfig }
  | { readonly ok: false; readonly reason: LocalEnvParseErrorReason; readonly detail: string }

/** Injected TOML parse function (DI). Defaults to `Bun.TOML.parse` at the call
 *  site; tests pass a stub so the validator is exercised in isolation. MUST
 *  return a parsed value or THROW on syntax error — the validator catches the
 *  throw and maps it to `toml_syntax` (fail-closed). */
export type TomlParse = (body: string) => unknown

/** The structural seam threaded onto a spawned shell's env. Mirrors exactly
 *  what `applyLocalEnv` consumes. Duck-typed so `@/tool` / `@/agent` need not
 *  import this slice's barrel — they carry the same shape. */
export interface LocalEnvSelection {
  /** Concrete var overlays for the selected env. */
  readonly vars: Readonly<Record<string, string>>
  /** PATH fragments to prepend (declaration order). */
  readonly pathPrepend: readonly string[]
}
