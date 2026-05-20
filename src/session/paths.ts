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

/** Thrown by {@link sanitizeId} when an id contains characters that would
 *  escape `sessionsRoot()` or otherwise misbehave as a filesystem name. */
export class SessionIdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionIdError"
  }
}

/** Maximum allowed id length. `crypto.randomUUID()` is 36 chars — the cap is
 *  far above the legitimate range and keeps pathologically long ids out of
 *  the filesystem layer. */
const MAX_ID_LEN = 128

/** Hardened id validator: enforces that an id is safe to use as a single
 *  filesystem path component under {@link sessionsRoot}. Rejects empties,
 *  path separators (`/`, `\`), NUL + ASCII control bytes, `.`/`..` segments,
 *  and leading `-` (CLI-flag confusion). Length-caps at {@link MAX_ID_LEN}.
 *
 *  `crypto.randomUUID()` output (lowercase hex + dashes) passes unchanged,
 *  so the legitimate `--new-session` and fork mint paths continue to work. */
export const sanitizeId = (id: string): string => {
  if (typeof id !== "string") {
    throw new SessionIdError(`session id must be a string, got ${typeof id}`)
  }
  if (id.length === 0) {
    throw new SessionIdError("session id must not be empty")
  }
  if (id.length > MAX_ID_LEN) {
    throw new SessionIdError(`session id exceeds max length (${MAX_ID_LEN}): ${id.length}`)
  }
  if (id === "." || id === "..") {
    throw new SessionIdError(`session id must not be "." or ".."`)
  }
  if (id.startsWith("-")) {
    throw new SessionIdError(`session id must not start with "-": ${id}`)
  }
  // Path separators (forward + back), NUL, ASCII control chars (0x00-0x1f, 0x7f)
  // would all escape or corrupt the per-id JSON file location. Reject early.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit guard against control bytes in id
  if (/[/\\\x00-\x1f\x7f]/.test(id)) {
    throw new SessionIdError(
      `session id contains forbidden character (path separator or control byte): ${JSON.stringify(id)}`,
    )
  }
  return id
}

export const sessionFilePath = (id: string): string =>
  join(sessionsRoot(), `${sanitizeId(id)}.json`)

export const archivedFilePath = (id: string): string =>
  join(sessionsRoot(), "archived", `${sanitizeId(id)}.json`)

export const indexFilePath = (): string => join(sessionsRoot(), "index.jsonl")
