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

import { writeStderr } from "./terminal-io"

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LOG_LEVEL_SET = new Set<string>(LOG_LEVELS)

/** SWE-bench Docker image cache levels (upstream `run_evaluation` vocabulary).
 *  `none` rebuilds + discards everything; `env` (the upstream default and ours)
 *  keeps base + per-repo env images warm; `instance` also keeps per-instance
 *  images for fastest re-runs of the SAME instance. */
export const SWEBENCH_CACHE_LEVELS = ["none", "base", "env", "instance"] as const
export type SwebenchCacheLevel = (typeof SWEBENCH_CACHE_LEVELS)[number]

const SWEBENCH_CACHE_LEVEL_SET = new Set<string>(SWEBENCH_CACHE_LEVELS)

const stderrWarn = (msg: string): void => {
  // Direct write because the logger imports US; using logger here would loop.
  writeStderr(`[quanta] config: ${msg}\n`)
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

/** Parse a delimiter-separated list (`,` `:` `;` `\n`). Trims, drops empties.
 *  Returns a frozen array (length 0 ⇒ caller treats as "no extras"). Used for
 *  list-shaped env vars that EXTEND a code-side default (operator merge, not
 *  replace) — keeps audited defaults intact while admitting ecosystem additions
 *  (Rust `target/`, new package managers like `uv`/`poetry`, etc). */
const parseStringList = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw.length === 0) return Object.freeze([])
  const parts: string[] = []
  for (const piece of raw.split(/[,:;\n]/)) {
    const t = piece.trim()
    if (t.length > 0) parts.push(t)
  }
  return Object.freeze(parts)
}

const parseSessionListFormat = (raw: string | undefined): "rich" | "plain" | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  if (raw === "rich" || raw === "plain") return raw
  stderrWarn(
    `ignoring unknown QUANTA_SESSION_LIST_FORMAT="${raw}" — valid: rich|plain — falling back to TTY auto-detect`,
  )
  return undefined
}

const parseSwebenchCacheLevel = (raw: string | undefined): SwebenchCacheLevel => {
  if (raw === undefined) return "env"
  if (SWEBENCH_CACHE_LEVEL_SET.has(raw)) return raw as SwebenchCacheLevel
  stderrWarn(
    `ignoring unknown QUANTA_SWEBENCH_CACHE_LEVEL="${raw}" — valid: ${SWEBENCH_CACHE_LEVELS.join("|")} — defaulting to "env"`,
  )
  return "env"
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
  /** ADR-0062 cap-as-instruction dispatch enforcement (`QUANTA_CAP_ENFORCE=1`).
   *  Default false — opt-in seam that injects a system-reminder when a tool's
   *  prior `nextAction` is ignored on the next call against the same target. */
  readonly capEnforce: boolean
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
  /** Extra cache directory names appended to the audited
   *  `DEFAULT_CACHE_DIR_NAMES` SSOT in `apps/bench/cache-pathspecs.ts`.
   *  `QUANTA_BENCH_CACHE_PATHSPECS_EXTRA` is a `,`/`:`/`;`/newline-separated
   *  list — merge semantics (NOT replace), so adding `target` (Rust) does
   *  not silently drop `__pycache__` (Python). Empty ⇒ defaults only. */
  readonly cachePathspecsExtra: readonly string[]
  /** Extra literal command prefixes appended to the audited env-regime
   *  detection set in `agent/dispatch-dedup.ts#DEFAULT_ENV_PREFIXES`.
   *  `QUANTA_DEDUP_ENV_PREFIXES_EXTRA` is a delimiter-separated list of
   *  LITERAL first-token names (e.g. `uv,poetry,cargo`). Operator merge
   *  semantics — defaults intact. Used to keep the dedup gate's env brake
   *  current with new package managers without code edits. */
  readonly dedupEnvPrefixesExtra: readonly string[]
  /** Permission state-file override (`QUANTA_PERMISSION_STATE`). Absent ⇒
   *  feature site computes `<quantaHome>/permission-state.json`. */
  readonly permissionStateFile: string | undefined
  /** SSH connection marker (`SSH_CONNECTION`). Used by ADR-0046's
   *  `resolveHostId()` to decide between `<user>@<host>` and `localhost`. */
  readonly sshConnection: string | undefined
  /** SWE-bench Docker image cache level (`QUANTA_SWEBENCH_CACHE_LEVEL`).
   *  Default `env` (upstream default) — keeps base+env images warm so a batch
   *  doesn't rebuild the expensive per-repo conda env per instance. */
  readonly swebenchCacheLevel: SwebenchCacheLevel
  /** SWE-bench `--clean` flag (`QUANTA_SWEBENCH_CLEAN`). Default false — keep
   *  images at/under cacheLevel between runs (warm pool). */
  readonly swebenchClean: boolean
  /** SWE-bench grading parallelism (`QUANTA_SWEBENCH_MAX_WORKERS`). Absent ⇒
   *  the harness config computes `min(4, ceil(cpus * 0.75))`. */
  readonly swebenchMaxWorkers: number | undefined
  /** SWE-bench image namespace (`QUANTA_SWEBENCH_NAMESPACE`). Absent ⇒ the
   *  harness config picks by arch ("none" ⇒ build locally; avoids x86 pulls
   *  that would emulate on arm64). */
  readonly swebenchNamespace: string | undefined
  /** SWE-bench `--force_rebuild` (`QUANTA_SWEBENCH_FORCE_REBUILD`). Default
   *  false — reuse cached images unless explicitly invalidated. */
  readonly swebenchForceRebuild: boolean
  /** Explicit Python interpreter for the SWE-bench harness
   *  (`QUANTA_SWEBENCH_PYTHON_BIN`). Absent ⇒ python-swebench.ts probes
   *  `python` then `python3`. Useful on hosts whose `python3` is too old
   *  for the harness (the package uses PEP 604 `list | None`, needs 3.10+);
   *  set to e.g. `python3.11` or an absolute path to override the probe. */
  readonly swebenchPythonBin: string | undefined
  /** Per-instance wall-clock budget for the bench runner (`QUANTA_BENCH_TIMEOUT_MS`).
   *  Absent ⇒ batch mode default (120_000ms). Surface for `apps/agent/
   *  mode-presets/batch.ts` (RFC may-22 Phase 4). */
  readonly benchTimeoutMs: number | undefined
  /** Max turns per instance for the bench runner (`QUANTA_MAX_TURNS`).
   *  Absent ⇒ batch mode default from BUDGET_PRESETS.batch. */
  readonly maxTurnsBatch: number | undefined
  /** Force `--prepare-images` to attempt the local build even on arm64
   *  (`QUANTA_SWEBENCH_PREPARE_FORCE`). Default false — arm64 skips prepare
   *  (conda crashes under x86 emulation; the eval path pulls prebuilt). */
  readonly swebenchPrepareForce: boolean
  /** Pinned run id (`QUANTA_RUN_ID`). Set ONCE by the bench launcher so
   *  observe + predictions + report all group under the same persistent
   *  `runs/<runId>/` dir (no per-call `Date.now()` drift). Absent ⇒
   *  `apps/bench/paths.ts#benchRunId` mints a `run-<Date.now()>` id. */
  readonly runId: string | undefined
  /** Preferences home override (`QUANTA_PREFS_HOME`). Absent ⇒ slash-command
   *  prefs/usage paths fall back to `os.homedir()`. */
  readonly prefsHome: string | undefined
  /** Last-reported token count (`QUANTA_LAST_TOKENS`). Surfaced by the
   *  `/context` slash command. Absent ⇒ the command omits the line. */
  readonly lastTokens: string | undefined
  /** `quanta session list` default format pin (`QUANTA_SESSION_LIST_FORMAT`).
   *  `plain` keeps the byte-identical legacy table (back-compat + pipelines);
   *  `rich` opts into the Codex-inspired TUI on a real TTY. Absent ⇒ the CLI
   *  surface picks `rich` when `process.stdout.isTTY`, else `plain`. */
  readonly sessionListFormat: "rich" | "plain" | undefined
  /** `quanta session list` default cap (`QUANTA_SESSION_LIST_MAX`). Applies
   *  only to the rich format (plain stays uncapped). Absent ⇒ the dispatcher
   *  defaults to 10. */
  readonly sessionListMax: number | undefined
  /** S5 hook hardening — per-handler timeout in ms (`QUANTA_HOOK_TIMEOUT_MS`).
   *  Absent ⇒ `hooks.ts` `DEFAULT_HOOK_TIMEOUT_MS` (5000). A timed-out handler
   *  logs a warning and the bus continues to the next handler. A
   *  per-registration override (`HookOnOptions.timeoutMs`) WINS over this
   *  default — the env knob is the operator-side floor for hosts that did not
   *  specify a per-hook timeout. */
  readonly hookTimeoutMs: number | undefined
  /** S5 hook hardening — max handlers per event (`QUANTA_HOOK_MAX_HANDLERS`).
   *  Absent ⇒ `hooks.ts` `MAX_HANDLERS_PER_EVENT` (64). Registering above the
   *  cap throws `HookRegistrationError` (load-bearing — surfaces a host
   *  misconfiguration loudly rather than silently dropping handlers). */
  readonly hookMaxHandlers: number | undefined
  /** S5 hook hardening — max emit payload size in BYTES
   *  (`QUANTA_HOOK_MAX_PAYLOAD_BYTES`). Absent ⇒ `hooks.ts`
   *  `MAX_PAYLOAD_BYTES` (1_048_576 = 1MB). Oversize payloads are TRUNCATED
   *  with a stable marker (graceful degradation — the dispatch still fires
   *  so a host that watches a hook never observes a missed event from a
   *  pathological argument). */
  readonly hookMaxPayloadBytes: number | undefined
  /** ADR-0287 async-tool kind activation (`QUANTA_ASYNC_TOOLS=1|on|true`).
   *  Default false — opt-in. When true the composition root constructs the
   *  `DefaultDeferredResultRegistry` and wires `poll_deferred` + every
   *  `defineToolAsync` instance to it; when false those tools degrade to
   *  synchronous execution (byte-identical to the pre-ADR path). */
  readonly asyncTools: boolean
  /** ADR-0286 deferred-result registry max live handles
   *  (`QUANTA_DEFERRED_CAP`). Absent ⇒ `DEFAULT_DEFERRED_CAP` (1000). LRU
   *  eviction; pending/running entries are never evicted (see
   *  `default-registry.ts` invariant #3). */
  readonly deferredCap: number | undefined
}

const stringOrUndef = (raw: string | undefined): string | undefined =>
  typeof raw === "string" && raw.length > 0 ? raw : undefined

const loadFromEnv = (env: NodeJS.ProcessEnv): RuntimeConfig => {
  return Object.freeze({
    logLevel: parseLogLevel(env["QUANTA_LOG_LEVEL"]),
    compactTokens: parsePositiveInt(env["QUANTA_COMPACT_TOKENS"], "QUANTA_COMPACT_TOKENS"),
    fsJailDisabled: parseBool(env["QUANTA_FS_JAIL"] === "off" ? "1" : undefined),
    capEnforce: parseBool(env["QUANTA_CAP_ENFORCE"]),
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
    llmStreamIdleMs: parsePositiveInt(
      env["QUANTA_LLM_STREAM_IDLE_MS"],
      "QUANTA_LLM_STREAM_IDLE_MS",
    ),
    quantaHome: stringOrUndef(env["QUANTA_HOME"]),
    benchHome: stringOrUndef(env["QUANTA_BENCH_HOME"]),
    cachePathspecsExtra: parseStringList(env["QUANTA_BENCH_CACHE_PATHSPECS_EXTRA"]),
    dedupEnvPrefixesExtra: parseStringList(env["QUANTA_DEDUP_ENV_PREFIXES_EXTRA"]),
    permissionStateFile: stringOrUndef(env["QUANTA_PERMISSION_STATE"]),
    sshConnection: stringOrUndef(env["SSH_CONNECTION"]),
    swebenchCacheLevel: parseSwebenchCacheLevel(env["QUANTA_SWEBENCH_CACHE_LEVEL"]),
    swebenchClean: parseBool(env["QUANTA_SWEBENCH_CLEAN"]),
    swebenchMaxWorkers: parsePositiveInt(
      env["QUANTA_SWEBENCH_MAX_WORKERS"],
      "QUANTA_SWEBENCH_MAX_WORKERS",
    ),
    swebenchNamespace: stringOrUndef(env["QUANTA_SWEBENCH_NAMESPACE"]),
    swebenchForceRebuild: parseBool(env["QUANTA_SWEBENCH_FORCE_REBUILD"]),
    swebenchPythonBin: stringOrUndef(env["QUANTA_SWEBENCH_PYTHON_BIN"]),
    benchTimeoutMs: parsePositiveInt(env["QUANTA_BENCH_TIMEOUT_MS"], "QUANTA_BENCH_TIMEOUT_MS"),
    maxTurnsBatch: parsePositiveInt(env["QUANTA_MAX_TURNS"], "QUANTA_MAX_TURNS"),
    swebenchPrepareForce: parseBool(env["QUANTA_SWEBENCH_PREPARE_FORCE"]),
    runId: stringOrUndef(env["QUANTA_RUN_ID"]),
    prefsHome: stringOrUndef(env["QUANTA_PREFS_HOME"]),
    lastTokens: stringOrUndef(env["QUANTA_LAST_TOKENS"]),
    sessionListFormat: parseSessionListFormat(env["QUANTA_SESSION_LIST_FORMAT"]),
    sessionListMax: parsePositiveInt(env["QUANTA_SESSION_LIST_MAX"], "QUANTA_SESSION_LIST_MAX"),
    hookTimeoutMs: parsePositiveInt(env["QUANTA_HOOK_TIMEOUT_MS"], "QUANTA_HOOK_TIMEOUT_MS"),
    hookMaxHandlers: parsePositiveInt(env["QUANTA_HOOK_MAX_HANDLERS"], "QUANTA_HOOK_MAX_HANDLERS"),
    hookMaxPayloadBytes: parsePositiveInt(
      env["QUANTA_HOOK_MAX_PAYLOAD_BYTES"],
      "QUANTA_HOOK_MAX_PAYLOAD_BYTES",
    ),
    asyncTools: parseBool(env["QUANTA_ASYNC_TOOLS"]),
    deferredCap: parsePositiveInt(env["QUANTA_DEFERRED_CAP"], "QUANTA_DEFERRED_CAP"),
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
