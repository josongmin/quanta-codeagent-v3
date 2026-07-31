import { readFile } from "node:fs/promises"
import {
  type FetchLike,
  refreshToken,
  resolveOAuthConfig,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { errMessage } from "@/shared"

export interface RefreshRemoteAuthJsonOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: FetchLike
  readonly nowMs?: () => number
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

/**
 * Full-remote boxes receive only a stripped short-lived access token and cannot
 * refresh it. Refresh locally before provisioning so a revoked/stale access
 * token fails before we pay the box bootstrap tax.
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
  const current = JSON.parse(await readFile(authFile, "utf8")) as TokenRecord
  const now = opts.nowMs?.() ?? Date.now()
  try {
    const next = await refreshToken({
      cfg: resolveOAuthConfig(opts.env ?? process.env),
      current,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    })
    await writeToken(authFile, next)
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
