import { levelEnabled, runtimeConfig } from "@/shared";
/** Resolve the effective threshold: explicit option ›› `runtimeConfig().logLevel` ›› default.
 *  S5: a single owner of the env (`runtime-config.ts`) validates `QUANTA_LOG_LEVEL`
 *  once at startup — a garbage value falls back to `info` with a stderr warn,
 *  rather than silently dropping every log line. */
const resolveLevel = (explicit) => explicit ?? runtimeConfig().logLevel;
const defaultSink = (line) => {
    // stderr only: stdout is reserved for the agent stream (same rule as @/shared).
    process.stderr.write(`${line}\n`);
};
/**
 * Structured, JSON-per-line logger for machine-consumable observability.
 *
 * Distinct from `@/shared`'s `logger`, which emits a tiny human `[level] msg`
 * line. This one emits one `JSON.stringify(LogRecord)` per call so downstream
 * tooling (the agent loop, adapters, later a collector) can parse fields. It
 * deliberately reuses the shared level ordering + env var rather than wrapping
 * the shared logger, because the shared logger's output format is not JSON.
 */
export class StructuredLogger {
    /** Effective threshold stored as the level NAME (not a numeric rank) so the
     *  awkward reverse-lookup the old `levelName()` did for `child()` is gone —
     *  level-gating routes through the shared `levelEnabled` predicate. */
    threshold;
    sink;
    now;
    base;
    constructor(options = {}, base = {}) {
        this.threshold = resolveLevel(options.level);
        this.sink = options.sink ?? defaultSink;
        this.now = options.now ?? Date.now;
        this.base = base;
    }
    /** Derive a child logger that injects `fields` into every record (e.g. a request id). */
    child(fields) {
        return new StructuredLogger({ level: this.threshold, sink: this.sink, now: this.now }, { ...this.base, ...fields });
    }
    emit(level, event, fields) {
        if (!levelEnabled(level, this.threshold))
            return;
        const record = {
            ts: this.now(),
            level,
            event,
            fields: { ...this.base, ...fields },
        };
        this.sink(JSON.stringify(record));
    }
    debug(event, fields) {
        this.emit("debug", event, fields);
    }
    info(event, fields) {
        this.emit("info", event, fields);
    }
    warn(event, fields) {
        this.emit("warn", event, fields);
    }
    error(event, fields) {
        this.emit("error", event, fields);
    }
}
/** Shared default instance. Tests construct fresh instances instead. */
export const log = new StructuredLogger();
