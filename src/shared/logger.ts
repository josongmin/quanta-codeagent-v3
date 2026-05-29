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
import { type LogLevel, runtimeConfig } from "./runtime-config"
import { writeStderr } from "./terminal-io"

export type { LogLevel }

/** Canonical severity ordering (debug < info < warn < error). Single source
 *  of truth for every level-gating logger so the two output formats (this
 *  line logger + `@/observability`'s JSON logger) can never disagree on which
 *  levels are enabled at a given threshold. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Should a record at `level` be emitted given the configured `threshold`?
 *  Both arguments are level NAMES (not numeric ranks) so callers never touch
 *  the ordering map directly. `error` is the strictest threshold; `debug` the
 *  loosest. */
export const levelEnabled = (level: LogLevel, threshold: LogLevel): boolean =>
  LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold]

/** Strip C0/C1/DEL control chars (incl. embedded `\n`/`\r`/`\b`) and ANSI CSI
 *  escape sequences so a hostile `e.message` cannot forge log lines (R2 audit-M
 *  — `[error] credentials leaked: <admin-token>` injection via `\n` in thrown
 *  payload). The intentional terminating `\n` appended in `write` is OUTSIDE
 *  this layer, so single-line discipline is preserved. */
const sanitizeLogText = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, "?")

const write = (level: LogLevel, msg: string, meta?: unknown): void => {
  if (!levelEnabled(level, runtimeConfig().logLevel)) return
  const safeMsg = sanitizeLogText(msg)
  const line = `[${level}] ${safeMsg}`
  const text =
    meta === undefined ? line : `${line} ${sanitizeLogText(JSON.stringify(meta))}`
  writeStderr(`${text}\n`)
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
}
