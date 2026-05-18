export type LogLevel = "debug" | "info" | "warn" | "error"

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const threshold: LogLevel = (process.env.QUANTA_LOG_LEVEL as LogLevel) ?? "info"

const write = (level: LogLevel, msg: string, meta?: unknown): void => {
  if (ORDER[level] < ORDER[threshold]) return
  const line = `[${level}] ${msg}`
  const text = meta === undefined ? line : `${line} ${JSON.stringify(meta)}`
  // Logs go to stderr so stdout stays reserved for the agent stream.
  process.stderr.write(`${text}\n`)
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
}
