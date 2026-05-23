/**
 * Structured stderr logger.
 *
 * Threshold gating reads from {@link runtimeConfig} on every `write` call so
 * an env override applied AFTER module load (integration tests, child-spawn
 * harness) is observed. The config itself is frozen at first access — see
 * `./runtime-config.ts` — so the threshold doesn't churn within a run.
 *
 * Logs go to stderr so stdout stays reserved for the agent stream.
 */
import { runtimeConfig } from "./runtime-config";
/** Canonical severity ordering (debug < info < warn < error). Single source
 *  of truth for every level-gating logger so the two output formats (this
 *  line logger + `@/observability`'s JSON logger) can never disagree on which
 *  levels are enabled at a given threshold. */
export const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
/** Should a record at `level` be emitted given the configured `threshold`?
 *  Both arguments are level NAMES (not numeric ranks) so callers never touch
 *  the ordering map directly. `error` is the strictest threshold; `debug` the
 *  loosest. */
export const levelEnabled = (level, threshold) => LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold];
const write = (level, msg, meta) => {
    if (!levelEnabled(level, runtimeConfig().logLevel))
        return;
    const line = `[${level}] ${msg}`;
    const text = meta === undefined ? line : `${line} ${JSON.stringify(meta)}`;
    process.stderr.write(`${text}\n`);
};
export const logger = {
    debug: (msg, meta) => write("debug", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
};
