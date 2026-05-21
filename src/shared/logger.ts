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

export type { LogLevel }

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const write = (level: LogLevel, msg: string, meta?: unknown): void => {
  if (ORDER[level] < ORDER[runtimeConfig().logLevel]) return
  const line = `[${level}] ${msg}`
  const text = meta === undefined ? line : `${line} ${JSON.stringify(meta)}`
  process.stderr.write(`${text}\n`)
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
}
