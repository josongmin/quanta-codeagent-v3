import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Session-store path resolution.
 *
 * Default root: `~/.quanta/sessions`. The `QUANTA_SESSIONS_DIR` env var
 * overrides this wholesale — same override pattern as `QUANTA_MEMORY_PATH`
 * (see `src/apps/cli/internal.ts:84`). Read at call time so tests can swap
 * roots per-case via `process.env`.
 */
export const sessionsRoot = (): string =>
  process.env.QUANTA_SESSIONS_DIR ?? join(homedir(), ".quanta", "sessions")

export const sessionFilePath = (id: string): string => join(sessionsRoot(), `${id}.json`)

export const archivedFilePath = (id: string): string =>
  join(sessionsRoot(), "archived", `${id}.json`)

export const indexFilePath = (): string => join(sessionsRoot(), "index.jsonl")
