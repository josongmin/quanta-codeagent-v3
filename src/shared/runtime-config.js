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
export const LOG_LEVELS = ["debug", "info", "warn", "error"];
const LOG_LEVEL_SET = new Set(LOG_LEVELS);
/** SWE-bench Docker image cache levels (upstream `run_evaluation` vocabulary).
 *  `none` rebuilds + discards everything; `env` (the upstream default and ours)
 *  keeps base + per-repo env images warm; `instance` also keeps per-instance
 *  images for fastest re-runs of the SAME instance. */
export const SWEBENCH_CACHE_LEVELS = ["none", "base", "env", "instance"];
const SWEBENCH_CACHE_LEVEL_SET = new Set(SWEBENCH_CACHE_LEVELS);
const stderrWarn = (msg) => {
    // Direct write because the logger imports US; using logger here would loop.
    process.stderr.write(`[quanta] config: ${msg}\n`);
};
const parseLogLevel = (raw) => {
    if (raw === undefined)
        return "info";
    if (LOG_LEVEL_SET.has(raw))
        return raw;
    stderrWarn(`ignoring unknown QUANTA_LOG_LEVEL="${raw}" — valid: ${LOG_LEVELS.join("|")} — defaulting to "info"`);
    return "info";
};
const parsePositiveInt = (raw, varName) => {
    if (raw === undefined)
        return undefined;
    const trimmed = raw.trim();
    // Reject non-integer / non-positive / extra whitespace / hex / sign:
    if (!/^\d+$/.test(trimmed)) {
        stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`);
        return undefined;
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n <= 0) {
        stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`);
        return undefined;
    }
    return n;
};
const parseBool = (raw) => {
    if (raw === undefined)
        return false;
    return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on";
};
/** Parse a delimiter-separated list (`,` `:` `;` `\n`). Trims, drops empties.
 *  Returns a frozen array (length 0 ⇒ caller treats as "no extras"). Used for
 *  list-shaped env vars that EXTEND a code-side default (operator merge, not
 *  replace) — keeps audited defaults intact while admitting ecosystem additions
 *  (Rust `target/`, new package managers like `uv`/`poetry`, etc). */
const parseStringList = (raw) => {
    if (raw === undefined || raw.length === 0)
        return Object.freeze([]);
    const parts = [];
    for (const piece of raw.split(/[,:;\n]/)) {
        const t = piece.trim();
        if (t.length > 0)
            parts.push(t);
    }
    return Object.freeze(parts);
};
const parseSwebenchCacheLevel = (raw) => {
    if (raw === undefined)
        return "env";
    if (SWEBENCH_CACHE_LEVEL_SET.has(raw))
        return raw;
    stderrWarn(`ignoring unknown QUANTA_SWEBENCH_CACHE_LEVEL="${raw}" — valid: ${SWEBENCH_CACHE_LEVELS.join("|")} — defaulting to "env"`);
    return "env";
};
const stringOrUndef = (raw) => typeof raw === "string" && raw.length > 0 ? raw : undefined;
const loadFromEnv = (env) => {
    return Object.freeze({
        logLevel: parseLogLevel(env["QUANTA_LOG_LEVEL"]),
        compactTokens: parsePositiveInt(env["QUANTA_COMPACT_TOKENS"], "QUANTA_COMPACT_TOKENS"),
        fsJailDisabled: parseBool(env["QUANTA_FS_JAIL"] === "off" ? "1" : undefined),
        gitSha: stringOrUndef(env["QUANTA_GIT_SHA"]),
        pricingVersion: stringOrUndef(env["QUANTA_PRICING_VERSION"]),
        sessionsDir: stringOrUndef(env["QUANTA_SESSIONS_DIR"]),
        hitlOverridesPath: stringOrUndef(env["QUANTA_HITL_OVERRIDES"]),
        toolOutputMaxChars: parsePositiveInt(env["QUANTA_TOOL_OUTPUT_MAX"], "QUANTA_TOOL_OUTPUT_MAX"),
        toolOutputSpillKeep: parsePositiveInt(env["QUANTA_TOOL_OUTPUT_SPILL_KEEP"], "QUANTA_TOOL_OUTPUT_SPILL_KEEP"),
        llmStreamFirstChunkMs: parsePositiveInt(env["QUANTA_LLM_STREAM_FIRST_CHUNK_MS"], "QUANTA_LLM_STREAM_FIRST_CHUNK_MS"),
        llmStreamIdleMs: parsePositiveInt(env["QUANTA_LLM_STREAM_IDLE_MS"], "QUANTA_LLM_STREAM_IDLE_MS"),
        quantaHome: stringOrUndef(env["QUANTA_HOME"]),
        benchHome: stringOrUndef(env["QUANTA_BENCH_HOME"]),
        cachePathspecsExtra: parseStringList(env["QUANTA_BENCH_CACHE_PATHSPECS_EXTRA"]),
        dedupEnvPrefixesExtra: parseStringList(env["QUANTA_DEDUP_ENV_PREFIXES_EXTRA"]),
        permissionStateFile: stringOrUndef(env["QUANTA_PERMISSION_STATE"]),
        sshConnection: stringOrUndef(env["SSH_CONNECTION"]),
        swebenchCacheLevel: parseSwebenchCacheLevel(env["QUANTA_SWEBENCH_CACHE_LEVEL"]),
        swebenchClean: parseBool(env["QUANTA_SWEBENCH_CLEAN"]),
        swebenchMaxWorkers: parsePositiveInt(env["QUANTA_SWEBENCH_MAX_WORKERS"], "QUANTA_SWEBENCH_MAX_WORKERS"),
        swebenchNamespace: stringOrUndef(env["QUANTA_SWEBENCH_NAMESPACE"]),
        swebenchForceRebuild: parseBool(env["QUANTA_SWEBENCH_FORCE_REBUILD"]),
        swebenchPythonBin: stringOrUndef(env["QUANTA_SWEBENCH_PYTHON_BIN"]),
        benchTimeoutMs: parsePositiveInt(env["QUANTA_BENCH_TIMEOUT_MS"], "QUANTA_BENCH_TIMEOUT_MS"),
        maxTurnsBatch: parsePositiveInt(env["QUANTA_MAX_TURNS"], "QUANTA_MAX_TURNS"),
        swebenchPrepareForce: parseBool(env["QUANTA_SWEBENCH_PREPARE_FORCE"]),
        runId: stringOrUndef(env["QUANTA_RUN_ID"]),
        prefsHome: stringOrUndef(env["QUANTA_PREFS_HOME"]),
        lastTokens: stringOrUndef(env["QUANTA_LAST_TOKENS"]),
    });
};
let cached;
/** Read the frozen runtime config. First call evaluates + freezes; subsequent
 *  calls return the cached value. Env changes during a run have NO effect on
 *  the returned object — intentional, so a test/harness that mutates env mid-
 *  run can't desync feature behavior. */
export const runtimeConfig = () => {
    if (cached === undefined)
        cached = loadFromEnv(process.env);
    return cached;
};
/** Test-only: reset the cache so a test can drive a different env snapshot.
 *  Production code MUST NOT call this — the scanner forbids it outside tests. */
export const __resetRuntimeConfig = () => {
    cached = undefined;
};
