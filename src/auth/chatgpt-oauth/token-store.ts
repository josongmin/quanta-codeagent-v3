import { existsSync, readFileSync, statSync } from "node:fs"
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { decodeJwtClaims } from "./jwt"
import { chatgptTokenPath, codexAuthPath, resolveCodexHome, resolveQuantaHome } from "./paths"

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

export type ChatgptTokenSource = "quanta" | "codex"
export type ChatgptTokenSourcePreference = "auto" | "quanta" | "codex"

export interface ResolvedTokenRecord {
  readonly path: string
  readonly source: ChatgptTokenSource
  readonly record: TokenRecord
}

const assertPrivateFileMode = (path: string, mode: number): void => {
  if (process.platform === "win32") return
  if ((mode & 0o077) !== 0) {
    throw new TokenStoreError(
      `token file has loose permissions (mode 0${mode.toString(8)}); ` +
        "expected 0600. Run /login again to regenerate.",
    )
  }
}

const parseTokenRecordObject = (parsed: unknown): TokenRecord => {
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

const deriveExpiresAt = (...tokens: readonly string[]): string => {
  for (const token of tokens) {
    try {
      const claims = decodeJwtClaims(token)
      if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
        return new Date(claims.exp * 1000).toISOString()
      }
    } catch {
      // try next token; codex auth may contain a non-JWT field in future.
    }
  }
  throw new TokenStoreError("missing/invalid field: expires_at (no JWT exp claim found)")
}

const parseCodexAuthObject = (parsed: unknown): TokenRecord => {
  if (parsed === null || typeof parsed !== "object") {
    throw new TokenStoreError("codex auth file is not a JSON object")
  }
  const obj = parsed as Record<string, unknown>
  if (obj.auth_mode !== "chatgpt") {
    throw new TokenStoreError("codex auth_mode is not chatgpt")
  }
  if (obj.tokens === null || typeof obj.tokens !== "object") {
    throw new TokenStoreError("codex auth missing/invalid tokens object")
  }
  const tokens = obj.tokens as Record<string, unknown>
  for (const k of ["access_token", "refresh_token", "id_token", "account_id"] as const) {
    if (typeof tokens[k] !== "string") {
      throw new TokenStoreError(`codex auth missing/invalid field: tokens.${k}`)
    }
  }

  const claims = (() => {
    try {
      return decodeJwtClaims(tokens.id_token as string)
    } catch {
      return undefined
    }
  })()

  return {
    access_token: tokens.access_token as string,
    refresh_token: tokens.refresh_token as string,
    expires_at: deriveExpiresAt(tokens.id_token as string, tokens.access_token as string),
    id_token: tokens.id_token as string,
    account_id:
      typeof claims?.chatgpt_account_id === "string"
        ? claims.chatgpt_account_id
        : (tokens.account_id as string),
    ...(typeof claims?.chatgpt_plan_type === "string"
      ? { plan_type: claims.chatgpt_plan_type }
      : {}),
    ...(typeof obj.last_refresh === "string" ? { last_refresh: obj.last_refresh } : {}),
  }
}

const readParsedFileSync = <T>(
  path: string,
  parse: (parsed: unknown) => T,
): T | null => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new TokenStoreError(`read failed: ${(e as Error).message}`)
  }
  assertPrivateFileMode(path, statSync(path).mode & 0o777)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new TokenStoreError(`json parse failed: ${(e as Error).message}`)
  }
  return parse(parsed)
}

const readParsedFile = async <T>(
  path: string,
  parse: (parsed: unknown) => T,
): Promise<T | null> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new TokenStoreError(`read failed: ${(e as Error).message}`)
  }
  assertPrivateFileMode(path, (await stat(path)).mode & 0o777)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new TokenStoreError(`json parse failed: ${(e as Error).message}`)
  }
  return parse(parsed)
}

/** Candidate credential locations. Quanta-owned token stays canonical and
 *  wins when present unless the operator explicitly forces `codex` via
 *  `QUANTA_CHATGPT_AUTH_SOURCE=codex`. Codex auth is always read-only; any
 *  refreshed bundle is persisted back to quanta's token path. */
export const resolveChatgptTokenSourcePreference = (
  env: Record<string, string | undefined>,
): ChatgptTokenSourcePreference => {
  const raw = env.QUANTA_CHATGPT_AUTH_SOURCE?.trim().toLowerCase()
  return raw === "codex" || raw === "quanta" ? raw : "auto"
}

export const resolveChatgptTokenCandidates = (
  env: Record<string, string | undefined>,
): readonly { path: string; source: ChatgptTokenSource }[] => {
  const quanta = {
    path: chatgptTokenPath(resolveQuantaHome(env)),
    source: "quanta" as const,
  }
  const codex = {
    path: codexAuthPath(resolveCodexHome(env)),
    source: "codex" as const,
  }
  return resolveChatgptTokenSourcePreference(env) === "codex" ? [codex, quanta] : [quanta, codex]
}

/** Cheap sync probe for provider selection. Quanta token existence is enough;
 *  Codex auth needs a shape check so a non-ChatGPT Codex auth.json does not
 *  mis-route the provider ladder. Parse failures are treated as absent. */
export const hasUsableChatgptToken = (env: Record<string, string | undefined>): boolean => {
  const [quanta, codex] = resolveChatgptTokenCandidates(env)
  if (quanta !== undefined && existsSync(quanta.path)) return true
  if (codex === undefined || !existsSync(codex.path)) return false
  try {
    return readParsedFileSync(codex.path, parseCodexAuthObject) !== null
  } catch {
    return false
  }
}

/** Read the token record from disk. Returns `null` when absent. Throws
 *  TokenStoreError on permission / shape failure — we'd rather force a
 *  relogin than load a tampered or world-readable token. */
export const readToken = async (path: string): Promise<TokenRecord | null> => {
  return readParsedFile(path, parseTokenRecordObject)
}

/** Read Codex's auth bundle and project it into the canonical TokenRecord
 *  shape used by the adapter. The source file is read-only; refreshes are
 *  persisted to quanta's own token path, not back into Codex state. */
export const readCodexAuthToken = async (path: string): Promise<TokenRecord | null> =>
  readParsedFile(path, parseCodexAuthObject)

/** Resolve the first usable token for the current environment. Source order is
 *  canonical quanta token first, then read-only Codex auth fallback. */
export const readResolvedToken = async (
  env: Record<string, string | undefined>,
): Promise<ResolvedTokenRecord | null> => {
  for (const candidate of resolveChatgptTokenCandidates(env)) {
    const record =
      candidate.source === "quanta"
        ? await readToken(candidate.path)
        : await readCodexAuthToken(candidate.path)
    if (record !== null) {
      return {
        path: candidate.path,
        source: candidate.source,
        record,
      }
    }
  }
  return null
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
