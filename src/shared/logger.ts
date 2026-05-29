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

/** Strip control chars (C0/C1/DEL, embedded `\n`/`\r`/`\b`), ANSI escape
 *  sequences (CSI / OSC / DCS / APC / SOS / PM, terminated by BEL or ESC-\),
 *  and Unicode bidi / zero-width chars so a hostile `e.message` cannot forge
 *  log lines (R2 audit-M / R3 audit-H — `[error] credentials leaked: …`
 *  injection via `\n`, terminal-title forge via `\x1b]0;…\x07`, visual
 *  reordering via U+202E RTL override). The intentional terminating `\n`
 *  appended in `write` is OUTSIDE this layer, so single-line discipline is
 *  preserved. NOTE: `new RegExp(string)` avoids biome's
 *  `noControlCharactersInRegex` rule trip on the literal form. */
const ANSI_OSC_DCS_APC_RE = new RegExp(
  "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\",
  "g",
)
const ANSI_CSI_RE = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g")
const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f]", "g")
const BIDI_ZW_RE = new RegExp("[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g")

const sanitizeLogText = (s: string): string =>
  s
    .replace(ANSI_OSC_DCS_APC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(CONTROL_RE, "?")
    .replace(BIDI_ZW_RE, "")

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
