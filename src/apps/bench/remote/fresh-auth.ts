import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createNodeLockFileStore, FileBasedLock } from "@/auth"
import {
  type FetchLike,
  refreshToken,
  refreshTokenTransaction,
  resolveOAuthConfig,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"
import type { OAuthRefreshLockPort } from "@/auth/oauth-refresh-lock"
import { errMessage, isRecord } from "@/shared"

export interface RefreshRemoteAuthJsonOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: FetchLike
  readonly nowMs?: () => number
  readonly lock?: OAuthRefreshLockPort
}

/** The shipped access token must outlast the whole remote run (provision +
 *  patch-gen + grading — comfortably under an hour) for the local-refresh
 *  fallback to be safe. Below this remaining margin we do NOT fall back; the
 *  refresh failure is fatal as before. */
const FALLBACK_MIN_REMAINING_MS = 60 * 60 * 1000

/** Remaining lifetime (ms) of a token record's `expires_at`, or 0 when missing /
 *  unparseable — an absent expiry is treated as already-expired so it never
 *  qualifies for the fresh-token fallback below. */
const remainingMs = (rec: TokenRecord, nowMs: number): number => {
  const exp = typeof rec.expires_at === "string" ? Date.parse(rec.expires_at) : Number.NaN
  return Number.isFinite(exp) ? exp - nowMs : 0
}

const asTokenRecord = (parsed: unknown): TokenRecord | null => {
  if (!isRecord(parsed) || typeof parsed.access_token !== "string") return null
  if (typeof parsed.refresh_token !== "string" || typeof parsed.expires_at !== "string") {
    return null
  }
  return parsed as unknown as TokenRecord
}

const defaultRefreshLock = (authFile: string, nowMs: () => number): OAuthRefreshLockPort =>
  new FileBasedLock({
    store: createNodeLockFileStore(join(dirname(authFile), "locks")),
    clock: { now: nowMs },
    pid: process.pid,
  })

const sleepClosed = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw new Error("refresh transaction aborted")
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error("refresh transaction aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Full-remote boxes receive only a stripped short-lived access token and cannot
 * refresh it. Refresh locally before provisioning so a revoked/stale access
 * token fails before we pay the box bootstrap tax.
 *
 * Refresh is the same ChatGPT transaction as the LLM adapter: acquire, re-read,
 * refresh only if still expired, persist, release. Two bench/LLM holders must
 * not rotate the same refresh token without the lock.
 *
 * FALLBACK (jun-25): the issuer (auth.openai.com) can be unreachable LOCALLY —
 * a corp proxy / endpoint-security stack (e.g. Veraport/MagicLine) resets the
 * TLS connection — while the bench BOX itself has clean egress and would call
 * the model fine. The local refresh exists ONLY to avoid shipping a STALE
 * token, so when refresh fails but the EXISTING access token still outlasts the
 * whole run by a comfortable margin, ship it as-is rather than aborting a run
 * the box could complete. The fallback is announced on stderr (never silent) so
 * a genuinely-revoked-but-unexpired token still surfaces as a box-side 401.
 */
export const refreshRemoteAuthJson = async (
  authFile: string,
  opts: RefreshRemoteAuthJsonOptions = {},
): Promise<string> => {
  const parsed: unknown = JSON.parse(await readFile(authFile, "utf8"))
  const current = asTokenRecord(parsed)
  if (current === null) {
    throw new Error("[full-remote] auth file malformed: missing access_token")
  }
  const nowMs = opts.nowMs ?? Date.now
  const now = nowMs()
  const lock = opts.lock ?? defaultRefreshLock(authFile, nowMs)
  try {
    const next = await refreshTokenTransaction(authFile, {
      lock,
      holderId: `${process.pid}-bench-fresh-auth`,
      nowMs,
      readCurrent: async () => {
        const latest: unknown = JSON.parse(await readFile(authFile, "utf8"))
        return asTokenRecord(latest)
      },
      persist: (token) => writeToken(authFile, token),
      refresh: (rec) =>
        refreshToken({
          cfg: resolveOAuthConfig(opts.env ?? process.env),
          current: rec,
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
          nowMs,
        }),
      sleep: sleepClosed,
    })
    return JSON.stringify(next)
  } catch (err) {
    const remaining = remainingMs(current, now)
    if (
      typeof current.access_token === "string" &&
      current.access_token !== "" &&
      remaining >= FALLBACK_MIN_REMAINING_MS
    ) {
      const mins = Math.round(remaining / 60_000)
      process.stderr.write(
        `[full-remote] local token refresh failed (${errMessage(err)}); ` +
          `shipping existing access token as-is (~${mins}min remaining). The box has clean egress and will use it.\n`,
      )
      return JSON.stringify(current)
    }
    throw err
  }
}
