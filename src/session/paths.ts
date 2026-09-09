import { join } from "node:path"
import { quantaHomeDir, runtimeConfig } from "@/shared"
import { defaultSessionRootProvider, type SessionRootProvider } from "./root-port"

/**
 * Session-store path resolution.
 *
 * Default root: `~/.quanta/sessions`. The `QUANTA_SESSIONS_DIR` env var
 * overrides this wholesale. Validation lives in `runtime-config.ts`; the
 * value is frozen at startup so a test that wants to swap roots per-case
 * calls `__resetRuntimeConfig()` instead of mutating `process.env`.
 *
 * Multi-tenant surfaces (Web / Tauri) should NOT use this sync resolver —
 * they inject a `SessionRootProvider` and call the `*Async` variants below.
 * `sessionsRoot()` is preserved for byte-identical CLI behavior; removing
 * it would change every existing call site's path resolution.
 */
export const sessionsRoot = (): string =>
  runtimeConfig().sessionsDir ?? join(quantaHomeDir(), "sessions")

/**
 * Async, provider-aware root resolver. Surface-agnostic seam — the CLI
 * passes nothing (or the `defaultSessionRootProvider`) and gets exactly
 * `sessionsRoot()`; Web/Tauri pass a per-tenant provider.
 *
 * Byte-identical guarantee: when `provider === undefined`, the resolved
 * value MUST equal `sessionsRoot()` for any given runtime-config snapshot.
 * The default provider re-reads `runtimeConfig()` on each call to honor
 * `__resetRuntimeConfig()` between tests, matching the sync resolver.
 */
export const sessionsRootAsync = async (provider?: SessionRootProvider): Promise<string> =>
  (provider ?? defaultSessionRootProvider).resolve()

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

export const sessionMutationLockPath = (id: string): string =>
  join(sessionsRoot(), ".locks", `${sanitizeId(id)}.lock`)

export const sessionGenerationPath = (id: string): string =>
  join(sessionsRoot(), ".generations", `${sanitizeId(id)}.json`)

/** Provider-aware twin of {@link sessionFilePath}. When `provider` is
 *  omitted the result is byte-identical to `sessionFilePath(id)`. */
export const sessionFilePathAsync = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<string> => join(await sessionsRootAsync(provider), `${sanitizeId(id)}.json`)

/** Provider-aware twin of {@link archivedFilePath}. */
export const archivedFilePathAsync = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<string> => join(await sessionsRootAsync(provider), "archived", `${sanitizeId(id)}.json`)

/** Provider-aware twin of {@link indexFilePath}. */
export const indexFilePathAsync = async (provider?: SessionRootProvider): Promise<string> =>
  join(await sessionsRootAsync(provider), "index.jsonl")

export const sessionMutationLockPathAsync = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<string> => join(await sessionsRootAsync(provider), ".locks", `${sanitizeId(id)}.lock`)

export const sessionGenerationPathAsync = async (
  id: string,
  provider?: SessionRootProvider,
): Promise<string> =>
  join(await sessionsRootAsync(provider), ".generations", `${sanitizeId(id)}.json`)
