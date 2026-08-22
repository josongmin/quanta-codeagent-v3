/**
 * Local-environment slice barrel (ADR-0455).
 *
 * Agent-driven, DECLARED per-project dev-environment selection. A project
 * declares named environments (env vars + PATH prepends) in
 * `.quanta/environment.toml` (or the Codex-compat
 * `.codex/environments/environment.toml`); the agent selects one and the
 * spawned shell tools get its vars / PATH applied ON TOP of the scrubbed,
 * allowlisted base env — NOT bypassing the allowlist.
 *
 * Default-OFF: no config file ⇒ ambient (scrubbed) env inherited byte-
 * identically (`applyLocalEnv` returns the same base reference).
 *
 * NO HEURISTICS: nothing is sniffed from the filesystem — every value comes
 * from the parsed config; the parser is pure/total and fail-closed.
 */

export { applyLocalEnv, selectEnvironment } from "./apply"
export { LOCAL_ENV_CANDIDATES, type LoadLocalEnvResult, loadLocalEnvConfig } from "./load"
export { parseLocalEnvConfig } from "./parse"
export type {
  DeclaredEnvironment,
  LocalEnvConfig,
  LocalEnvParseErrorReason,
  LocalEnvParseResult,
  LocalEnvSelection,
  TomlParse,
} from "./types"
