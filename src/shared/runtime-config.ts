/**
 * Frozen runtime config — the SINGLE place that touches `process.env`.
 *
 * Why this exists: scattered `process.env.X` reads have two recurring failure
 * modes that previous audits surfaced.
 *
 *  1. **Silent garbage acceptance.** `process.env.QUANTA_LOG_LEVEL as LogLevel`
 *     accepts any string; an unknown value made every comparison `<undefined`
 *     and silently dropped EVERY log line. CRITICAL during incidents.
 *  2. **Mid-run env mutation.** `process.env` read at call-site means a test
 *     or harness that temporarily overrides a var changes behavior
 *     unpredictably across the run. We pin the values at first access so the
 *     run is reproducible.
 *
 * Contract:
 *   - First call evaluates + freezes. Subsequent reads are cached.
 *   - Invalid values are REJECTED + a single stderr line warns once (no
 *     logger import — logger depends on us; we use raw `process.stderr.write`).
 *   - Defaults are documented inline. Adding a new env var goes here.
 *   - `__resetRuntimeConfig()` is the test seam — production code MUST NOT
 *     call it.
 *
 * Adding an env var: write a `parseFoo` helper + add a field to `RuntimeConfig`
 * + parse in `loadFromEnv`. Use the var FROM `runtimeConfig()`, never from
 * `process.env` directly. The anti-regression scanner bans the latter.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LOG_LEVEL_SET = new Set<string>(LOG_LEVELS)

const stderrWarn = (msg: string): void => {
  // Direct write because the logger imports US; using logger here would loop.
  process.stderr.write(`[quanta] config: ${msg}\n`)
}

const parseLogLevel = (raw: string | undefined): LogLevel => {
  if (raw === undefined) return "info"
  if (LOG_LEVEL_SET.has(raw)) return raw as LogLevel
  stderrWarn(
    `ignoring unknown QUANTA_LOG_LEVEL="${raw}" — valid: ${LOG_LEVELS.join("|")} — defaulting to "info"`,
  )
  return "info"
}

const parsePositiveInt = (raw: string | undefined, varName: string): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // Reject non-integer / non-positive / extra whitespace / hex / sign:
  if (!/^\d+$/.test(trimmed)) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`)
    return undefined
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(n) || n <= 0) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`)
    return undefined
  }
  return n
}

const parseBool = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on"
}

/** All runtime-tunable values, frozen at startup. Add fields here when a new
 *  env var is introduced — never read `process.env` from a feature site. */
export interface RuntimeConfig {
  readonly logLevel: LogLevel
  /** Compaction threshold override (tokens). Absent ⇒ use the per-config
   *  default in `agent/compaction.ts`. NEVER silently flipped by env. */
  readonly compactTokens: number | undefined
  /** FS jail disable flag (`QUANTA_FS_JAIL=off`). Default false (jail ON). */
  readonly fsJailDisabled: boolean
  /** Git SHA stamp for trajectory `producer.gitSha`. Set by the launcher
   *  (CI, dev script). Absent ⇒ field omitted from trajectory events. */
  readonly gitSha: string | undefined
  /** Trajectory pricing version override — pinned by op for reproducibility. */
  readonly pricingVersion: string | undefined
  /** Sessions root override (`QUANTA_SESSIONS_DIR`). Absent ⇒ session/paths
   *  computes `~/.quanta/sessions`. */
  readonly sessionsDir: string | undefined
  /** HITL overrides JSON path (`QUANTA_HITL_OVERRIDES`). Absent ⇒
   *  `agent/hitl-tier-registry` defaults to `~/.quanta/hitl-overrides.json`. */
  readonly hitlOverridesPath: string | undefined
  /** Tool output cap (`QUANTA_TOOL_OUTPUT_MAX`). Absent ⇒ default in
   *  `tool/output-spill.ts`. */
  readonly toolOutputMaxChars: number | undefined
  /** Tool spill retention (`QUANTA_TOOL_OUTPUT_SPILL_KEEP`). Absent ⇒ default. */
  readonly toolOutputSpillKeep: number | undefined
  /** LLM stream first-chunk timeout in ms (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS`).
   *  Absent ⇒ adapter default (60_000 ms). Read ONCE at adapter construction;
   *  T1 hang-stream guard. Reasoning models (o1/o3/gpt-5) can take 30s+ to
   *  first token, so default is generous. */
  readonly llmStreamFirstChunkMs: number | undefined
  /** LLM stream inter-chunk idle timeout in ms (`QUANTA_LLM_STREAM_IDLE_MS`).
   *  Absent ⇒ adapter default (120_000 ms). Read ONCE at adapter
   *  construction; T1 hang-stream guard. Long completions are OK. */
  readonly llmStreamIdleMs: number | undefined
  /** Quanta home dir override (`QUANTA_HOME`). Absent ⇒ feature sites compute
   *  `~/.quanta`. Used by ADR-0046 permission-store path resolution. */
  readonly quantaHome: string | undefined
  /** Bench artifacts root override (`QUANTA_BENCH_HOME`). Absent ⇒ bench
   *  computes a PERSISTENT default (never tmp): `<quantaHome>/bench`, else
   *  macOS `~/Library/quanta-codeagent-v3/bench`, else `~/.quanta/bench`. */
  readonly benchHome: string | undefined
  /** Permission state-file override (`QUANTA_PERMISSION_STATE`). Absent ⇒
   *  feature site computes `<quantaHome>/permission-state.json`. */
  readonly permissionStateFile: string | undefined
  /** SSH connection marker (`SSH_CONNECTION`). Used by ADR-0046's
   *  `resolveHostId()` to decide between `<user>@<host>` and `localhost`. */
  readonly sshConnection: string | undefined
}

const stringOrUndef = (raw: string | undefined): string | undefined =>
  typeof raw === "string" && raw.length > 0 ? raw : undefined

const loadFromEnv = (env: NodeJS.ProcessEnv): RuntimeConfig => {
  return Object.freeze({
    logLevel: parseLogLevel(env["QUANTA_LOG_LEVEL"]),
    compactTokens: parsePositiveInt(env["QUANTA_COMPACT_TOKENS"], "QUANTA_COMPACT_TOKENS"),
    fsJailDisabled: parseBool(env["QUANTA_FS_JAIL"] === "off" ? "1" : undefined),
    gitSha: stringOrUndef(env["QUANTA_GIT_SHA"]),
    pricingVersion: stringOrUndef(env["QUANTA_PRICING_VERSION"]),
    sessionsDir: stringOrUndef(env["QUANTA_SESSIONS_DIR"]),
    hitlOverridesPath: stringOrUndef(env["QUANTA_HITL_OVERRIDES"]),
    toolOutputMaxChars: parsePositiveInt(env["QUANTA_TOOL_OUTPUT_MAX"], "QUANTA_TOOL_OUTPUT_MAX"),
    toolOutputSpillKeep: parsePositiveInt(
      env["QUANTA_TOOL_OUTPUT_SPILL_KEEP"],
      "QUANTA_TOOL_OUTPUT_SPILL_KEEP",
    ),
    llmStreamFirstChunkMs: parsePositiveInt(
      env["QUANTA_LLM_STREAM_FIRST_CHUNK_MS"],
      "QUANTA_LLM_STREAM_FIRST_CHUNK_MS",
    ),
    llmStreamIdleMs: parsePositiveInt(env["QUANTA_LLM_STREAM_IDLE_MS"], "QUANTA_LLM_STREAM_IDLE_MS"),
    quantaHome: stringOrUndef(env["QUANTA_HOME"]),
    benchHome: stringOrUndef(env["QUANTA_BENCH_HOME"]),
    permissionStateFile: stringOrUndef(env["QUANTA_PERMISSION_STATE"]),
    sshConnection: stringOrUndef(env["SSH_CONNECTION"]),
  })
}

let cached: RuntimeConfig | undefined

/** Read the frozen runtime config. First call evaluates + freezes; subsequent
 *  calls return the cached value. Env changes during a run have NO effect on
 *  the returned object — intentional, so a test/harness that mutates env mid-
 *  run can't desync feature behavior. */
export const runtimeConfig = (): RuntimeConfig => {
  if (cached === undefined) cached = loadFromEnv(process.env)
  return cached
}

/** Test-only: reset the cache so a test can drive a different env snapshot.
 *  Production code MUST NOT call this — the scanner forbids it outside tests. */
export const __resetRuntimeConfig = (): void => {
  cached = undefined
}
