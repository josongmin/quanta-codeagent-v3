import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** On-disk token record. Mirrors the Codex auth-data shape (access / refresh
 *  / id + account_id) plus quanta-specific fields (`plan_type` cached from
 *  the id_token, `last_refresh` for UX). Optional fields are absent when
 *  unknown — never written as null / undefined. */
export interface TokenRecord {
  readonly access_token: string
  readonly refresh_token: string
  readonly expires_at: string
  readonly id_token?: string
  readonly account_id?: string
  readonly plan_type?: string
  readonly last_refresh?: string
}

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TokenStoreError"
  }
}

/** Read the token record from disk. Returns `null` when absent. Throws
 *  TokenStoreError on permission / shape failure — we'd rather force a
 *  relogin than load a tampered or world-readable token. */
export const readToken = async (path: string): Promise<TokenRecord | null> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new TokenStoreError(`read failed: ${(e as Error).message}`)
  }
  if (process.platform !== "win32") {
    const s = await stat(path)
    const mode = s.mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new TokenStoreError(
        `token file has loose permissions (mode 0${mode.toString(8)}); ` +
          "expected 0600. Run /login again to regenerate.",
      )
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new TokenStoreError(`json parse failed: ${(e as Error).message}`)
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new TokenStoreError("token file is not a JSON object")
  }
  const obj = parsed as Record<string, unknown>
  for (const k of ["access_token", "refresh_token", "expires_at"] as const) {
    if (typeof obj[k] !== "string") {
      throw new TokenStoreError(`missing/invalid field: ${k}`)
    }
  }
  return {
    access_token: obj.access_token as string,
    refresh_token: obj.refresh_token as string,
    expires_at: obj.expires_at as string,
    ...(typeof obj.id_token === "string" ? { id_token: obj.id_token } : {}),
    ...(typeof obj.account_id === "string" ? { account_id: obj.account_id } : {}),
    ...(typeof obj.plan_type === "string" ? { plan_type: obj.plan_type } : {}),
    ...(typeof obj.last_refresh === "string" ? { last_refresh: obj.last_refresh } : {}),
  }
}

/** Write the token record atomically with 0600 permissions. Atomic =
 *  write-to-tmp + rename, so a reader never sees a half-written file. */
export const writeToken = async (path: string, t: TokenRecord): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(t, null, 2)}\n`, "utf8")
  if (process.platform !== "win32") {
    await chmod(tmp, 0o600)
  }
  await rename(tmp, path)
}

/** Delete the token file. Idempotent — absent file is fine. */
export const deleteToken = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return
    throw new TokenStoreError(`delete failed: ${(e as Error).message}`)
  }
}

/** True when the stored `expires_at` is in the past, or within `skewMs` of
 *  now (default 30s — so we don't race a token that's about to expire
 *  mid-flight). Unparseable timestamp ⇒ treat as expired (force relogin
 *  rather than risk a 401 mid-stream). */
/** Default clock-skew cushion for {@link isExpired}: a 30-second window
 *  conservative enough to absorb client/issuer clock drift and the latency
 *  budget of an in-flight refresh without forcing premature relogin. */
export const DEFAULT_EXPIRY_SKEW_MS = 30_000

export const isExpired = (
  t: Pick<TokenRecord, "expires_at">,
  nowMs: number,
  skewMs = DEFAULT_EXPIRY_SKEW_MS,
): boolean => {
  const exp = Date.parse(t.expires_at)
  if (Number.isNaN(exp)) return true
  return exp - skewMs <= nowMs
}
